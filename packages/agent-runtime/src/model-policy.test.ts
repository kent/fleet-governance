import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { CharterV1 } from "@fleet/schemas";
import { TaskState } from "@fleet/sdk";
import type { ProposalCreatedView, TaskView } from "@fleet/sdk";
import type { AnchoredProposal } from "./policy.js";
import { ModelPolicy } from "./model-policy.js";
import { ScriptedProvider } from "./providers/scripted.js";
import type { Provider, CompleteRequest, CompleteResult } from "./providers/types.js";

const charter: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "Implement the failing functions so the test suite passes.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests"],
  forbiddenActions: [],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 400000 },
  stopConditions: ["tests_pass"],
};

const task: TaskView = {
  id: 7n,
  operator: "0x0000000000000000000000000000000000000001",
  state: TaskState.Open,
  charterVersion: 3,
  charterHash: `0x${"aa".repeat(32)}` as Hex,
  charterText: JSON.stringify(charter),
  charter,
  createdAt: 1_700_000_000n,
  expiresAt: 1_700_003_600n,
  decisionCount: 0,
  openEscalations: 0,
} as unknown as TaskView;

const proposal: ProposalCreatedView = {
  proposalId: 123456789012345678901234567890n,
  proposer: "0x0000000000000000000000000000000000000002",
  targets: [],
  values: [],
  calldatas: [],
  description: "## Decision\n\nfetch from examples.internal",
  blockNumber: 10n,
  txHash: `0x${"bb".repeat(32)}` as Hex,
} as unknown as ProposalCreatedView;

function anchored(overrides: Partial<AnchoredProposal> = {}): AnchoredProposal {
  return {
    blockNumber: 10n,
    blockHash: `0x${"cc".repeat(32)}` as Hex,
    proposal,
    decision: null,
    task,
    charter,
    member: { agentId: 2, role: "critic", manifest: '{"role":"critic"}' },
    verificationOk: true,
    ...overrides,
  };
}

/** A provider that always fails the same way, for the timeout and transport paths. */
function failingProvider(error: "timeout" | "provider", raw: string): Provider {
  return {
    name: "scripted",
    async complete<T>(_req: CompleteRequest<T>): Promise<CompleteResult<T>> {
      return { ok: false, error, raw, latencyMs: 4, usage: { inputTokens: 11, outputTokens: 0, model: "m" } };
    },
  };
}

describe("ModelPolicy", () => {
  it("assembles a VoteV1 from the model's five fields and the anchored proposal's own id", async () => {
    const provider = new ScriptedProvider(() => ({
      raw: JSON.stringify({
        support: "AGAINST",
        rationale: "examples.internal is not on the charter's external allowlist.",
        assumptions: ["The charter text shown is current."],
        riskFlags: ["exfiltration"],
      }),
      usage: { inputTokens: 900, outputTokens: 60, model: "test-model" },
    }));
    const policy = new ModelPolicy({ provider, promptVersion: "1" });

    const output = await policy.evaluateProposal(anchored());

    expect(output.kind).toBe("vote");
    if (output.kind !== "vote") return;
    expect(output.vote).toEqual({
      schema: "fleet.vote.v1",
      proposalId: "123456789012345678901234567890",
      support: "AGAINST",
      rationale: "examples.internal is not on the charter's external allowlist.",
      assumptions: ["The charter text shown is current."],
      riskFlags: ["exfiltration"],
    });
    expect(output.meta).toEqual({
      provider: "scripted",
      model: "test-model",
      promptVersion: "1",
      latencyMs: expect.any(Number),
      inputTokens: 900,
      outputTokens: 60,
    });
  });

  it("keeps confidenceBps when the model gives one and drops it when the model gives null", async () => {
    const withConfidence = new ModelPolicy({
      provider: new ScriptedProvider(() => ({
        raw: JSON.stringify({ support: "FOR", rationale: "ok", assumptions: [], riskFlags: [], confidenceBps: 8000 }),
      })),
      promptVersion: "1",
    });
    const withNull = new ModelPolicy({
      provider: new ScriptedProvider(() => ({
        raw: JSON.stringify({ support: "FOR", rationale: "ok", assumptions: [], riskFlags: [], confidenceBps: null }),
      })),
      promptVersion: "1",
    });

    const kept = await withConfidence.evaluateProposal(anchored());
    const dropped = await withNull.evaluateProposal(anchored());

    expect(kept.kind === "vote" && kept.vote.confidenceBps).toBe(8000);
    expect(dropped.kind === "vote" && "confidenceBps" in dropped.vote).toBe(false);
  });

  it("never lets the model choose the proposal id or the schema, even when it emits them", async () => {
    const provider = new ScriptedProvider(() => ({
      raw: JSON.stringify({
        schema: "fleet.vote.v1",
        proposalId: "1",
        support: "FOR",
        rationale: "voting on a different proposal",
        assumptions: [],
        riskFlags: [],
      }),
    }));
    const policy = new ModelPolicy({ provider, promptVersion: "1" });

    const output = await policy.evaluateProposal(anchored());

    // Rejected outright rather than accepted with the identity fields stripped: either way the
    // model's "1" never reaches a ballot, and spec 10.6 makes an unusable reply a missing vote.
    expect(output.kind).toBe("malformed");
  });

  it("maps a malformed reply to malformed, carrying the raw text the model returned", async () => {
    const policy = new ModelPolicy({
      provider: new ScriptedProvider(() => ({ raw: "I think we should vote against this." })),
      promptVersion: "1",
    });

    const output = await policy.evaluateProposal(anchored());

    expect(output.kind).toBe("malformed");
    expect(output.kind === "malformed" && output.raw).toContain("I think we should vote against this.");
  });

  it("maps a timeout to absent (a missing vote), never to a ballot", async () => {
    const policy = new ModelPolicy({ provider: failingProvider("timeout", "aborted after 60000ms"), promptVersion: "1" });

    const output = await policy.evaluateProposal(anchored());

    expect(output.kind).toBe("absent");
    expect(output.kind === "absent" && output.why).toBe("timeout: aborted after 60000ms");
  });

  it("maps a transport failure to absent as well, naming the provider error kind", async () => {
    const policy = new ModelPolicy({ provider: failingProvider("provider", "HTTP 503"), promptVersion: "1" });

    const output = await policy.evaluateProposal(anchored());

    expect(output.kind).toBe("absent");
    expect(output.kind === "absent" && output.why).toBe("provider: HTTP 503");
  });

  it("sends the evaluate-proposal prompt for the member's own role, with the proposal wrapped as untrusted", async () => {
    let seen: { system: string; user: string; maxTokens: number } | null = null;
    const provider = new ScriptedProvider((req) => {
      seen = req;
      return { raw: JSON.stringify({ support: "ABSTAIN", rationale: "no view", assumptions: [], riskFlags: [] }) };
    });
    const policy = new ModelPolicy({ provider, promptVersion: "2", maxTokens: 1234 });

    await policy.evaluateProposal(anchored());

    expect(seen).not.toBeNull();
    const request = seen as unknown as { system: string; user: string; maxTokens: number };
    expect(request.maxTokens).toBe(1234);
    expect(request.user).toContain("123456789012345678901234567890");
    expect(request.user).toContain('<untrusted name="proposalDescription">');
    expect(request.system).toContain("# Role: Critic");
  });

  it("repairs one malformed reply and accepts the corrected one (withOneRepair, spec 10.6)", async () => {
    const replies = [
      "not json at all",
      JSON.stringify({ support: "FOR", rationale: "corrected", assumptions: [], riskFlags: [] }),
    ];
    let calls = 0;
    const provider = new ScriptedProvider(() => ({ raw: replies[calls++] ?? "" }));
    const policy = new ModelPolicy({ provider, promptVersion: "1" });

    const output = await policy.evaluateProposal(anchored());

    expect(calls).toBe(2);
    expect(output.kind).toBe("vote");
    expect(output.kind === "vote" && output.vote.rationale).toBe("corrected");
  });
});
