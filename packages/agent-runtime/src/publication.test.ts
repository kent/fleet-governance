import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import type { Hex } from "viem";
import type { CharterV1, DecisionV1 } from "@fleet/schemas";
import { artifactPublicationPermit, payloadHashForExecution, TaskState } from "@fleet/sdk";
import { LedgerWatcher } from "@fleet/gateway";
import { Workspace } from "./sandbox/workspace.js";
import { ToolRouter } from "./sandbox/tools.js";
import type { ArtifactPublisher, ToolCall } from "./sandbox/tools.js";
import { ScriptedProvider } from "./providers/scripted.js";
import { TaskLoop } from "./taskloop.js";
import type { RecordedDecision, TaskLoopEvent } from "./taskloop.js";
import { StepBoard } from "./coordinator.js";
import { escalationDraft, toDecision } from "./divergence.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const addresses = { executor: address(1), artifactStore: address(2), ledger: address(3),
  registry: address(4), hook: address(5), governor: address(6), token: address(7), timelock: address(8) };
const charter: CharterV1 = { schema: "fleet.charter.v1", goal: "Prepare and publish the task artifact after review.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests", "publish_artifact"], forbiddenActions: [],
  externalAllowlist: [], budget: { toolCalls: 100, inferenceTokens: 100000 }, stopConditions: ["artifact_published"] };
const publish: ToolCall = { class: "publish_artifact", target: "result.txt", args: {} };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "fleet-publication-")); dirs.push(dir);
  await mkdir(join(dir, "fixture")); await writeFile(join(dir, "fixture/result.txt"), Buffer.from([0, 255, 1]));
  const workspace = await Workspace.fromFixture(join(dir, "fixture"), 0, join(dir, "workspaces"));
  const task = { id: 1n, operator: address(10), createdAt: 1n, expiresAt: 1000n, state: TaskState.Open,
    charterVersion: 1, charterHash: keccak256(toHex("charter")), charterText: JSON.stringify(charter),
    charter, decisionCount: 0, openEscalations: 0 };
  const approved = new Set<string>(); const decisions: RecordedDecision[] = []; const spent = new Set<string>();
  const calls: string[] = []; const events: TaskLoopEvent[] = []; const proposed: DecisionV1[] = [];
  const watcher = new LedgerWatcher({ getTask: async () => task, isPaused: async () => false,
    timestamp: async () => 10n, blockNumber: async () => 2n, exceptionVersion: async (_, hash) => approved.has(hash) ? 1 : 0,
    escalationVersion: async () => 0 }, 1n);
  const adapter: ArtifactPublisher = {
    prepare: async (digest, snapshot) => artifactPublicationPermit({ chainId: 31337, addresses, actor: address(11),
      taskId: snapshot.taskId, charterVersion: snapshot.charterVersion, targetCodeHash: keccak256(toHex("code")), digest, expiresAt: snapshot.expiresAt }),
    execute: async permit => {
      const hash = payloadHashForExecution(permit);
      if (!approved.has(hash)) throw new Error("unapproved");
      if (spent.has(hash)) throw new Error("already consumed");
      spent.add(hash); calls.push(hash); return JSON.stringify({ published: true, payloadHash: hash });
    },
  };
  const router = new ToolRouter({ workspace, watcher, agentId: 0, budget: { toolCalls: 0 }, log: () => {}, artifactPublisher: adapter,
    dockerRunTests: async () => ({ passed: true, output: "passed" }) });
  return { dir, workspace, task, approved, decisions, calls, events, proposed, watcher, adapter, router };
}

describe("publication through the task tools", () => {
  it("hashes exact bytes, retains the permission across retries, and holds changed bytes for new approval", async () => {
    const s = await setup();
    const before = await s.router.call(publish);
    if (before.ok || !("blocked" in before) || !before.blocked.draft?.execution) throw new Error("expected exact permission draft");
    const permit = before.blocked.draft.execution;
    expect(permit.data.slice(-64)).toBe(keccak256(new Uint8Array([0, 255, 1])).slice(2));
    expect(s.calls).toEqual([]);
    s.approved.add(before.blocked.payloadHash);
    await s.workspace.writeFile("result.txt", "different bytes");
    expect(await s.router.call(publish)).toMatchObject({ ok: false, blocked: { reason: "permission_required" } });
    expect(s.calls).toEqual([]);
    await writeFile(join(s.workspace.dir, "result.txt"), Buffer.from([0, 255, 1]));
    expect(await s.router.call(publish)).toMatchObject({ ok: true });
    expect(await s.router.call(publish)).toMatchObject({ ok: false, error: "already consumed" });
    expect(s.calls).toHaveLength(1);
  });

  it("rejects outside paths and unavailable or aborted execution", async () => {
    const s = await setup();
    expect(await s.router.call({ ...publish, target: "../secret" })).toMatchObject({ ok: false, error: expect.stringContaining("traversal") });
    const unavailable = new ToolRouter({ workspace: s.workspace, watcher: s.watcher, agentId: 0, budget: { toolCalls: 0 }, log: () => {} });
    expect(await unavailable.call(publish)).toMatchObject({ ok: false, blocked: { draft: null } });
    const abort = new AbortController(); abort.abort();
    expect(await s.router.call(publish, abort.signal)).toEqual({ ok: false, error: "aborted" });
    expect(s.calls).toEqual([]);
  });

  it("escalates the permit itself and refuses to rebase an old draft onto a new charter", async () => {
    const s = await setup(); const result = await s.router.call(publish);
    if (result.ok || !("blocked" in result) || !result.blocked.draft) throw new Error("expected draft");
    const draft = escalationDraft(publish, result.blocked.draft);
    const context = { taskId: 1n, charterVersion: 1, agentId: 0, charter, rationale: "Needs human review." };
    const divergence = { source: "gateway_block" as const, agentId: 0, draft, blockedTool: publish };
    const decision = toDecision(divergence, context);
    expect(decision.kind).toBe("ESCALATE_TO_HUMAN");
    expect(decision.action).toBeUndefined();
    expect(decision.payloadHash).toBe(result.blocked.payloadHash);
    expect(() => toDecision(divergence, { ...context, charterVersion: 2 })).toThrow("current task and charter");
  });

  it.each(["approve", "reject", "drop"] as const)("lets the model choose and waits for exact settlement: %s", async outcome => {
    const s = await setup(); let step = 0;
    const provider = new ScriptedProvider(({ user }) => {
      if (user.includes("# Respond to a blocked action")) return { raw: JSON.stringify({ choice: outcome === "drop" ? "drop" : "propose", rationale: "Review this artifact before publication." }) };
      step++;
      // An unrelated recorded decision must not release a blocked publication retry.
      if (step === 3) s.task.decisionCount++;
      if (step === 4 && outcome === "approve") {
        const d = s.proposed[0]!; s.approved.add(d.payloadHash); s.task.decisionCount++;
        s.decisions.push({ kind: "GRANT_EXCEPTION", payloadHash: d.payloadHash as Hex, charterVersion: 1 });
      }
      return { raw: JSON.stringify({ tool: step === 1 ? { class: "run_tests", target: "npm test", args: {} } : publish, why: "Finish the task." }) };
    });
    const loop = new TaskLoop({ agentId: 0, role: "planner", provider, tools: s.router, board: new StepBoard(),
      isCoordinator: true, task: async () => s.task, decisions: async () => s.decisions,
      propose: async decision => { s.proposed.push(decision); return 1n; }, objections: { record: () => {} },
      log: event => s.events.push(event), maxSteps: 5, blockedBackoffMs: 0 });
    const result = await loop.run(new AbortController().signal);
    expect(result.testsPassed).toBe(true);
    expect(s.proposed).toHaveLength(outcome === "drop" ? 0 : 1);
    expect(s.calls).toHaveLength(outcome === "approve" ? 1 : 0);
    expect(result.stopReason).toBe(outcome === "approve" ? "artifact_published" : "max_steps");
    expect(s.events.filter(e => e.type === "retry_pending_decision").length).toBeGreaterThan(0);
  });
});
