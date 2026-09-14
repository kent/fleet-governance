import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { TaskState, payloadHashForAction } from "@fleet/sdk";
import type { TaskView } from "@fleet/sdk";
import type { CharterV1 } from "@fleet/schemas";
import { LedgerWatcher, describeAction } from "@fleet/gateway";
import type { LedgerClient } from "@fleet/gateway";
import { Workspace } from "./workspace.js";
import { ToolRouter } from "./tools.js";
import type { GatewayLogRecord } from "@fleet/gateway";

const ADDRESS = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const CHARTER_HASH = ("0x" + "a".repeat(64)) as Hex;

function baseCharter(overrides: Partial<CharterV1> = {}): CharterV1 {
  return {
    schema: "fleet.charter.v1",
    goal: "Make the fixture test suite pass without modifying test files.",
    allowedActionClasses: ["read_repo", "write_repo", "run_tests", "network_fetch", "package_install"],
    forbiddenActions: [],
    externalAllowlist: [],
    budget: { toolCalls: 100, inferenceTokens: 1_000_000 },
    stopConditions: [],
    ...overrides,
  };
}

function baseTaskView(charter: CharterV1, overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 7n,
    operator: ADDRESS as never,
    createdAt: 1n,
    expiresAt: 1_000_000n,
    state: TaskState.Open,
    charterVersion: 1,
    charterHash: CHARTER_HASH,
    decisionCount: 0,
    openEscalations: 0,
    charterText: JSON.stringify(charter),
    charter,
    ...overrides,
  };
}

type WatcherOpts = {
  exceptionVersion?: LedgerClient["exceptionVersion"];
  escalationVersion?: LedgerClient["escalationVersion"];
  taskOverrides?: Partial<TaskView>;
};

function makeWatcher(charter: CharterV1, opts: WatcherOpts = {}): { watcher: LedgerWatcher; client: LedgerClient } {
  const client: LedgerClient = {
    getTask: vi.fn(async () => baseTaskView(charter, opts.taskOverrides)),
    exceptionVersion: opts.exceptionVersion ?? vi.fn(async () => 0),
    escalationVersion: opts.escalationVersion ?? vi.fn(async () => 0),
    isPaused: vi.fn(async () => false),
    blockNumber: vi.fn(async () => 100n),
    timestamp: vi.fn(async () => 500_000n),
  };
  return { watcher: new LedgerWatcher(client, 7n, () => {}), client };
}

let fixtureDir: string;
let runDir: string;
let workspace: Workspace;

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "fleet-tools-fixture-"));
  runDir = await mkdtemp(join(tmpdir(), "fleet-tools-run-"));

  await fsWriteFile(
    join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "fixture-repo",
      version: "1.0.0",
      scripts: { test: "node -e \"console.log('fixture tests passed'); process.exit(0)\"" },
    }),
  );
  await mkdir(join(fixtureDir, "src"), { recursive: true });
  await fsWriteFile(join(fixtureDir, "src", "index.ts"), "export const answer = 42;\n");
  await mkdir(join(fixtureDir, "test"), { recursive: true });
  await fsWriteFile(join(fixtureDir, "test", "index.test.ts"), "// placeholder test\n");

  workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });
});

function makeLog(): { log: (r: GatewayLogRecord) => void; records: GatewayLogRecord[] } {
  const records: GatewayLogRecord[] = [];
  return { log: (r) => records.push(r), records };
}

describe("ToolRouter: read_repo / write_repo happy path", () => {
  it("read_repo returns the file's content when allowed by charter", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(result).toEqual({ ok: true, output: "export const answer = 42;\n" });
  });

  it("write_repo writes the file's content when allowed, and it is visible via readFile", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({
      class: "write_repo",
      target: "src/new-file.ts",
      args: { content: "export const hello = 1;\n" },
    });
    expect(result).toEqual({ ok: true, output: "wrote src/new-file.ts" });
    expect(await workspace.readFile("src/new-file.ts")).toBe("export const hello = 1;\n");
  });
});

describe("ToolRouter: path traversal is rejected", () => {
  it("read_repo with a .. target is rejected as an execution error, not a silent read", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log, records } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({ class: "read_repo", target: "../../etc/passwd", args: {} });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect("error" in result ? result.error : "").toMatch(/traversal/i);

    // The gateway still saw and logged this call (it has no way to know the target is a path
    // pointing outside the workspace); Workspace is what actually stopped it.
    expect(records).toHaveLength(1);
    expect(records[0]?.verdict).toBe("ALLOW");
  });

  it("write_repo with a .. target never writes outside the workspace", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({
      class: "write_repo",
      target: "../../../../../../tmp/escaped.ts",
      args: { content: "malicious" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("ToolRouter: write_repo blocked for test files when modify_tests is forbidden", () => {
  it("blocks a write under test/ with a forbidden_action verdict and a GRANT_EXCEPTION draft", async () => {
    const charter = baseCharter({ forbiddenActions: ["modify_tests"] });
    const { watcher } = makeWatcher(charter);
    const { log, records } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({
      class: "write_repo",
      target: "test/index.test.ts",
      args: { content: "// tampered" },
    });

    expect(result.ok).toBe(false);
    if (result.ok || !("blocked" in result)) throw new Error("unreachable");
    expect(result.blocked.verdict).toBe("BLOCK");
    expect(result.blocked.reason).toBe("forbidden_action");
    expect(result.blocked.draft?.kind).toBe("GRANT_EXCEPTION");

    expect(records).toHaveLength(1);
    expect(records[0]?.verdict).toBe("BLOCK");
    expect(records[0]?.reason).toBe("forbidden_action");

    // The write never actually happened.
    expect(await workspace.readFile("test/index.test.ts")).toBe("// placeholder test\n");
  });

  it("still allows writes outside test/ even when modify_tests is forbidden", async () => {
    const charter = baseCharter({ forbiddenActions: ["modify_tests"] });
    const { watcher } = makeWatcher(charter);
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({ class: "write_repo", target: "src/index.ts", args: { content: "// ok\n" } });
    expect(result).toEqual({ ok: true, output: "wrote src/index.ts" });
  });

  it("allows writes under test/ when modify_tests is not in forbiddenActions", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({
      class: "write_repo",
      target: "test/index.test.ts",
      args: { content: "// updated\n" },
    });
    expect(result).toEqual({ ok: true, output: "wrote test/index.test.ts" });
  });
});

describe("ToolRouter: network_fetch gateway allowlist and exceptions", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`served:${req.url}`);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("blocks a fetch to a non-allowlisted host with a GRANT_EXCEPTION draft, and never calls fetchImpl", async () => {
    const host = `127.0.0.1:${port}`;
    const { watcher } = makeWatcher(baseCharter({ externalAllowlist: [] }));
    const { log, records } = makeLog();
    const fetchImpl = vi.fn();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log, fetchImpl });

    const result = await router.call({
      class: "network_fetch",
      target: host,
      args: { path: "/hello", scheme: "http" },
    });

    expect(result.ok).toBe(false);
    if (result.ok || !("blocked" in result)) throw new Error("unreachable");
    expect(result.blocked.reason).toBe("target_not_allowlisted");
    expect(result.blocked.draft?.kind).toBe("GRANT_EXCEPTION");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(records[0]?.verdict).toBe("BLOCK");
  });

  it("allows the same fetch once exceptionVersion matches the current charter version for that exact payload", async () => {
    const host = `127.0.0.1:${port}`;
    const descriptor = describeAction({ class: "network_fetch", target: host, args: { path: "/hello", scheme: "http" } });
    const expectedPayloadHash = payloadHashForAction(descriptor);

    const exceptionVersion = vi.fn(async (_taskId: bigint, payloadHash: Hex) => (payloadHash === expectedPayloadHash ? 1 : 0));
    const { watcher } = makeWatcher(baseCharter({ externalAllowlist: [] }), { exceptionVersion });
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({
      class: "network_fetch",
      target: host,
      args: { path: "/hello", scheme: "http" },
    });

    expect(result).toEqual({ ok: true, output: "served:/hello" });
  });

  it("allows a fetch to a host on the charter's external allowlist without needing an exception", async () => {
    const host = `127.0.0.1:${port}`;
    const { watcher } = makeWatcher(baseCharter({ externalAllowlist: [host] }));
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({ class: "network_fetch", target: host, args: { path: "/ok", scheme: "http" } });
    expect(result).toEqual({ ok: true, output: "served:/ok" });
  });

  it("forces args.path to stay a path: it cannot smuggle in a different host ahead of the first slash", async () => {
    const host = `127.0.0.1:${port}`;
    const { watcher } = makeWatcher(baseCharter({ externalAllowlist: [host] }));
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    // Without the leading-slash guard, "attacker.example" would parse as userinfo and move the
    // request's authority to attacker.example instead of the allowlisted host.
    const result = await router.call({
      class: "network_fetch",
      target: host,
      args: { path: "attacker.example", scheme: "http" },
    });
    expect(result).toEqual({ ok: true, output: "served:/attacker.example" });
  });
});

describe("ToolRouter: budget exhaustion", () => {
  it("blocks with budget_exhausted once usage.toolCalls reaches the charter's budget, and keeps counting", async () => {
    const charter = baseCharter({ budget: { toolCalls: 2, inferenceTokens: 1_000_000 } });
    const { watcher } = makeWatcher(charter);
    const { log, records } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 2 }, log });

    const result = await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(result.ok).toBe(false);
    if (result.ok || !("blocked" in result)) throw new Error("unreachable");
    expect(result.blocked.reason).toBe("budget_exhausted");
    expect(result.blocked.draft).toBeNull();

    // usage() still incremented even though the call was blocked.
    expect(router.usage()).toEqual({ toolCalls: 3 });

    await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(router.usage()).toEqual({ toolCalls: 4 });
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.verdict === "BLOCK" && r.reason === "budget_exhausted")).toBe(true);
  });

  it("allows calls under budget and increments usage on each one", async () => {
    const charter = baseCharter({ budget: { toolCalls: 5, inferenceTokens: 1_000_000 } });
    const { watcher } = makeWatcher(charter);
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    expect(router.usage()).toEqual({ toolCalls: 0 });
    await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(router.usage()).toEqual({ toolCalls: 1 });
    await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(router.usage()).toEqual({ toolCalls: 2 });
  });
});

describe("ToolRouter: escalation is per payload, not task-wide", () => {
  it("blocks only the exact escalated call and leaves an unrelated call unaffected", async () => {
    const escalatedDescriptor = describeAction({ class: "read_repo", target: "src/index.ts", args: {} });
    const escalatedPayloadHash = payloadHashForAction(escalatedDescriptor);

    const escalationVersion = vi.fn(async (_taskId: bigint, payloadHash: Hex) =>
      payloadHash === escalatedPayloadHash ? 1 : 0,
    );
    const { watcher } = makeWatcher(baseCharter(), { escalationVersion });
    const { log, records } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const escalatedResult = await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(escalatedResult.ok).toBe(false);
    if (escalatedResult.ok || !("blocked" in escalatedResult)) throw new Error("unreachable");
    expect(escalatedResult.blocked.reason).toBe("escalated");
    expect(escalatedResult.blocked.draft).toBeNull();

    const otherResult = await router.call({ class: "read_repo", target: "src/new.ts", args: {} });
    // Different target -> different payload hash -> not the escalated one -> proceeds to a normal
    // execution attempt (this file does not exist in the fixture, so it fails to read, but that
    // is an execution error, not a gateway block, proving the gateway itself let it through).
    expect(otherResult.ok).toBe(false);
    if (otherResult.ok || !("error" in otherResult)) throw new Error("unreachable");

    expect(records).toHaveLength(2);
    expect(records[0]?.reason).toBe("escalated");
    expect(records[1]?.verdict).toBe("ALLOW");
  });
});

describe("ToolRouter: shell is always blocked", () => {
  it("returns the gateway's block for shell even when the charter lists it as allowed", async () => {
    const charter = baseCharter({ allowedActionClasses: [...baseCharter().allowedActionClasses, "shell"] });
    const { watcher } = makeWatcher(charter);
    const { log, records } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({ class: "shell", target: "rm -rf /", args: {} });
    expect(result.ok).toBe(false);
    if (result.ok || !("blocked" in result)) throw new Error("unreachable");
    expect(result.blocked.reason).toBe("class_not_allowed");
    expect(result.blocked.draft).toBeNull();
    expect(records).toHaveLength(1);
  });
});

describe("ToolRouter: run_tests", () => {
  it("uses the injected dockerRunTests and reports passed:true with no fallback marker on success", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log } = makeLog();
    const dockerRunTests = vi.fn(async (dir: string) => ({ passed: true, output: `docker ran tests in ${dir}` }));
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log, dockerRunTests });

    const result = await router.call({ class: "run_tests", target: "all", args: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = JSON.parse(result.output) as { passed: boolean; fallback?: string };
    expect(parsed.passed).toBe(true);
    expect(parsed.fallback).toBeUndefined();
    expect(dockerRunTests).toHaveBeenCalledWith(workspace.dir);
  });

  it("falls back to an in-process npm test, with a fallback:no-docker marker, when dockerRunTests throws", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log } = makeLog();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dockerRunTests = vi.fn(async () => {
      throw new Error("docker unavailable: `docker info` failed");
    });
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log, dockerRunTests });

    const result = await router.call({ class: "run_tests", target: "all", args: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = JSON.parse(result.output) as RunTestsOutputShape;
    expect(parsed.passed).toBe(true);
    expect(parsed.fallback).toBe("no-docker");
    expect(parsed.output).toContain("fixture tests passed");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("uses real Docker end to end when no dockerRunTests is injected", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    const result = await router.call({ class: "run_tests", target: "all", args: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = JSON.parse(result.output) as RunTestsOutputShape;
    expect(parsed.passed).toBe(true);
    expect(parsed.fallback).toBeUndefined();
    expect(parsed.output).toContain("fixture tests passed");
  }, 60_000);
});

type RunTestsOutputShape = { passed: boolean; output: string; fallback?: string };

describe("ToolRouter: package_install", () => {
  it("asserts the exact npm install command via an injected runner, without installing anything", async () => {
    const host = "registry.example.com";
    const charter = baseCharter({ externalAllowlist: [host] });
    const { watcher } = makeWatcher(charter);
    const { log } = makeLog();
    const packageInstallRunner = vi.fn(async (cmd: string, args: string[]) => ({
      code: 0,
      output: `would run: ${cmd} ${args.join(" ")}`,
    }));
    const router = new ToolRouter({
      workspace,
      watcher,
      agentId: 1,
      budget: { toolCalls: 0 },
      log,
      packageInstallRunner,
    });

    const result = await router.call({ class: "package_install", target: host, args: { pkg: "left-pad" } });
    expect(result.ok).toBe(true);
    expect(packageInstallRunner).toHaveBeenCalledWith(
      "npm",
      ["install", "left-pad", "--registry", `https://${host}`],
      { cwd: workspace.dir },
    );
  });

  it("blocks package_install for a host outside the charter's allowlist, and never calls the runner", async () => {
    const charter = baseCharter({ externalAllowlist: [] });
    const { watcher } = makeWatcher(charter);
    const { log } = makeLog();
    const packageInstallRunner = vi.fn();
    const router = new ToolRouter({
      workspace,
      watcher,
      agentId: 1,
      budget: { toolCalls: 0 },
      log,
      packageInstallRunner,
    });

    const result = await router.call({
      class: "package_install",
      target: "evil-registry.example.com",
      args: { pkg: "left-pad" },
    });
    expect(result.ok).toBe(false);
    if (result.ok || !("blocked" in result)) throw new Error("unreachable");
    expect(result.blocked.reason).toBe("target_not_allowlisted");
    expect(packageInstallRunner).not.toHaveBeenCalled();
  });
});

describe("ToolRouter: log record shape", () => {
  it("logs a full record for an ALLOW verdict", async () => {
    const { watcher } = makeWatcher(baseCharter());
    const { log, records } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 42, budget: { toolCalls: 0 }, log });

    await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.agentId).toBe(42);
    expect(record.taskId).toBe("7");
    expect(record.blockNumber).toBe("100");
    expect(record.charterVersion).toBe(1);
    expect(record.verdict).toBe("ALLOW");
    expect(record.basis).toBe("charter");
    expect(record.reason).toBeUndefined();
    expect(record.descriptor.class).toBe("read_repo");
    expect(record.descriptor.target).toBe("src/index.ts");
    expect(typeof record.payloadHash).toBe("string");
    expect(typeof record.ts).toBe("string");
  });

  it("logs a full record for a BLOCK verdict", async () => {
    const { watcher } = makeWatcher(baseCharter({ allowedActionClasses: [] }));
    const { log, records } = makeLog();
    const router = new ToolRouter({ workspace, watcher, agentId: 1, budget: { toolCalls: 0 }, log });

    await router.call({ class: "read_repo", target: "src/index.ts", args: {} });
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.verdict).toBe("BLOCK");
    expect(record.reason).toBe("class_not_allowed");
    expect(record.basis).toBeUndefined();
  });
});
