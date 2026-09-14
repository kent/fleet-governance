import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { TaskState } from "@fleet/sdk";
import type { TaskView } from "@fleet/sdk";
import type { CharterV1 } from "@fleet/schemas";
import { LedgerWatcher } from "./watcher.js";
import type { LedgerClient } from "./watcher.js";

const ADDRESS = "0x1111111111111111111111111111111111111111".slice(0, 42) as `0x${string}`;
const CHARTER_HASH = ("0x" + "a".repeat(64)) as Hex;

const charter: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "Make the test suite pass.",
  allowedActionClasses: ["read_repo"],
  forbiddenActions: [],
  externalAllowlist: [],
  budget: { toolCalls: 200, inferenceTokens: 2_000_000 },
  stopConditions: [],
};

function baseTaskView(overrides: Partial<TaskView> = {}): TaskView {
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

function makeFakeClient(overrides: Partial<LedgerClient> = {}): LedgerClient {
  return {
    getTask: vi.fn(async () => baseTaskView()),
    exceptionVersion: vi.fn(async () => 0),
    escalationVersion: vi.fn(async () => 0),
    isPaused: vi.fn(async () => false),
    blockNumber: vi.fn(async () => 100n),
    timestamp: vi.fn(async () => 500_000n),
    ...overrides,
  };
}

describe("LedgerWatcher.snapshot: happy path", () => {
  it("reads task, charter, paused state, block number, and timestamp from the client", async () => {
    const client = makeFakeClient();
    const watcher = new LedgerWatcher(client, 7n);
    const snapshot = await watcher.snapshot();

    expect(snapshot.taskId).toBe(7n);
    expect(snapshot.state).toBe("Open");
    expect(snapshot.expiresAt).toBe(1_000_000n);
    expect(snapshot.charterVersion).toBe(1);
    expect(snapshot.charter).toEqual(charter);
    expect(snapshot.paused).toBe(false);
    expect(snapshot.openEscalations).toBe(0);
    expect(snapshot.blockNumber).toBe(100n);
    expect(snapshot.now).toBe(500_000n);
  });

  it("maps every TaskState to its string name", async () => {
    for (const [state, name] of [
      [TaskState.Open, "Open"],
      [TaskState.Stopped, "Stopped"],
      [TaskState.Completed, "Completed"],
      [TaskState.Expired, "Expired"],
    ] as const) {
      const client = makeFakeClient({ getTask: vi.fn(async () => baseTaskView({ state })) });
      const watcher = new LedgerWatcher(client, 7n);
      const snapshot = await watcher.snapshot();
      expect(snapshot.state).toBe(name);
    }
  });

  it("memoises exceptionVersion and escalationVersion per payload hash, within one snapshot", async () => {
    const client = makeFakeClient();
    const watcher = new LedgerWatcher(client, 7n);
    const snapshot = await watcher.snapshot();

    const hashA = ("0x" + "1".repeat(64)) as Hex;
    const hashB = ("0x" + "2".repeat(64)) as Hex;

    await snapshot.exceptionVersion(hashA);
    await snapshot.exceptionVersion(hashA);
    await snapshot.exceptionVersion(hashB);
    expect(client.exceptionVersion).toHaveBeenCalledTimes(2);
    expect(client.exceptionVersion).toHaveBeenCalledWith(7n, hashA);
    expect(client.exceptionVersion).toHaveBeenCalledWith(7n, hashB);

    await snapshot.escalationVersion(hashA);
    await snapshot.escalationVersion(hashA);
    expect(client.escalationVersion).toHaveBeenCalledTimes(1);

    // A fresh snapshot gets a fresh memoisation scope.
    const snapshot2 = await watcher.snapshot();
    await snapshot2.exceptionVersion(hashA);
    expect(client.exceptionVersion).toHaveBeenCalledTimes(3);
  });
});

describe("LedgerWatcher.snapshot: fails closed on RPC failure", () => {
  it("reports paused=true and logs when getTask rejects", async () => {
    const logError = vi.fn();
    const client = makeFakeClient({ getTask: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    const watcher = new LedgerWatcher(client, 7n, logError);
    const snapshot = await watcher.snapshot();

    expect(snapshot.paused).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("reports paused=true and logs when isPaused rejects", async () => {
    const logError = vi.fn();
    const client = makeFakeClient({ isPaused: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    const watcher = new LedgerWatcher(client, 7n, logError);
    const snapshot = await watcher.snapshot();

    expect(snapshot.paused).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("reports paused=true and logs when blockNumber rejects", async () => {
    const logError = vi.fn();
    const client = makeFakeClient({ blockNumber: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    const watcher = new LedgerWatcher(client, 7n, logError);
    const snapshot = await watcher.snapshot();

    expect(snapshot.paused).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("reports paused=true and logs when the charter text fails to parse", async () => {
    const logError = vi.fn();
    const client = makeFakeClient({
      getTask: vi.fn(async () => baseTaskView({ charter: null, charterText: "not valid charter json" })),
    });
    const watcher = new LedgerWatcher(client, 7n, logError);
    const snapshot = await watcher.snapshot();

    expect(snapshot.paused).toBe(true);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("defaults to console.error when no logError is supplied", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = makeFakeClient({ getTask: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    const watcher = new LedgerWatcher(client, 7n);
    const snapshot = await watcher.snapshot();

    expect(snapshot.paused).toBe(true);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("a failed-closed snapshot's exceptionVersion and escalationVersion resolve to 0 without touching the client", async () => {
    const client = makeFakeClient({ getTask: vi.fn(async () => Promise.reject(new Error("rpc down"))) });
    const watcher = new LedgerWatcher(client, 7n, () => {});
    const snapshot = await watcher.snapshot();

    await expect(snapshot.exceptionVersion(("0x" + "1".repeat(64)) as Hex)).resolves.toBe(0);
    await expect(snapshot.escalationVersion(("0x" + "1".repeat(64)) as Hex)).resolves.toBe(0);
    expect(client.exceptionVersion).not.toHaveBeenCalled();
    expect(client.escalationVersion).not.toHaveBeenCalled();
  });
});

describe("LedgerWatcher.start", () => {
  it("polls and calls onChange only when charterVersion, paused, state, or openEscalations change", async () => {
    vi.useFakeTimers();
    try {
      let charterVersion = 1;
      const client = makeFakeClient({
        getTask: vi.fn(async () => baseTaskView({ charterVersion })),
      });
      const watcher = new LedgerWatcher(client, 7n);
      const onChange = vi.fn();

      const stop = watcher.start(onChange, 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Unchanged: no new call.
      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).toHaveBeenCalledTimes(1);

      // Changed: a new call.
      charterVersion = 2;
      await vi.advanceTimersByTimeAsync(1000);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange.mock.calls[1]?.[0]?.charterVersion).toBe(2);

      stop();
      charterVersion = 3;
      await vi.advanceTimersByTimeAsync(5000);
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
