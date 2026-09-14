import type { Hex } from "viem";
import { TaskState } from "@fleet/sdk";
import type { FleetClient } from "@fleet/sdk";
import type { CharterV1 } from "@fleet/schemas";
import type { LedgerSnapshot } from "./evaluate.js";

/**
 * The slice of `FleetClient` the watcher actually calls. Naming it separately (rather than
 * requiring a full `FleetClient` instance) lets a plain object stand in for one in tests, as the
 * task brief asks for ("a fake FleetClient (a plain object implementing the methods used)");
 * every real `FleetClient` already satisfies this structurally, so callers pass one unchanged.
 */
export type LedgerClient = Pick<
  FleetClient,
  "getTask" | "exceptionVersion" | "escalationVersion" | "isPaused" | "blockNumber" | "timestamp"
>;

const TASK_STATE_NAMES: Record<TaskState, LedgerSnapshot["state"]> = {
  [TaskState.Open]: "Open",
  [TaskState.Stopped]: "Stopped",
  [TaskState.Completed]: "Completed",
  [TaskState.Expired]: "Expired",
};

/**
 * Placeholder charter for a snapshot that failed closed (RPC failure, or a charter that will not
 * parse as `fleet.charter.v1`). `paused: true` makes `evaluateAction` block on its very first
 * check, before any charter field is ever read, so these values are never actually consulted;
 * they exist only to satisfy `LedgerSnapshot`'s type.
 */
const FAIL_CLOSED_CHARTER: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "unavailable: ledger snapshot failed closed",
  allowedActionClasses: [],
  forbiddenActions: [],
  externalAllowlist: [],
  budget: { toolCalls: 1, inferenceTokens: 1 },
  stopConditions: [],
};

function failClosedSnapshot(taskId: bigint): LedgerSnapshot {
  return {
    taskId,
    state: "Open",
    expiresAt: 0n,
    charterVersion: 0,
    charter: FAIL_CLOSED_CHARTER,
    paused: true,
    openEscalations: 0,
    exceptionVersion: async () => 0,
    escalationVersion: async () => 0,
    blockNumber: 0n,
    now: 0n,
  };
}

/**
 * Reads one task's ledger state on demand and, via `start`, on a poll loop. Every read goes
 * through `client`; on any failure (an RPC error, or a charter that will not parse) `snapshot()`
 * still resolves, reporting `paused: true` so the gateway fails closed, and reports the failure
 * to `logError` rather than throwing.
 */
export class LedgerWatcher {
  private readonly client: LedgerClient;
  private readonly taskId: bigint;
  private readonly logError: (message: string, error: unknown) => void;

  constructor(client: LedgerClient, taskId: bigint, logError: (message: string, error: unknown) => void = console.error) {
    this.client = client;
    this.taskId = taskId;
    this.logError = logError;
  }

  async snapshot(): Promise<LedgerSnapshot> {
    try {
      const [task, paused, blockNumber, now] = await Promise.all([
        this.client.getTask(this.taskId),
        this.client.isPaused(),
        this.client.blockNumber(),
        this.client.timestamp(),
      ]);
      if (!task.charter) {
        throw new Error(`task ${this.taskId.toString()}: charter text does not parse as fleet.charter.v1`);
      }

      const taskId = this.taskId;
      const client = this.client;
      const exceptionCache = new Map<Hex, Promise<number>>();
      const escalationCache = new Map<Hex, Promise<number>>();

      return {
        taskId,
        state: TASK_STATE_NAMES[task.state],
        expiresAt: task.expiresAt,
        charterVersion: task.charterVersion,
        charter: task.charter,
        paused,
        openEscalations: task.openEscalations,
        exceptionVersion(payloadHash) {
          let cached = exceptionCache.get(payloadHash);
          if (!cached) {
            cached = client.exceptionVersion(taskId, payloadHash);
            exceptionCache.set(payloadHash, cached);
          }
          return cached;
        },
        escalationVersion(payloadHash) {
          let cached = escalationCache.get(payloadHash);
          if (!cached) {
            cached = client.escalationVersion(taskId, payloadHash);
            escalationCache.set(payloadHash, cached);
          }
          return cached;
        },
        blockNumber,
        now,
      };
    } catch (err) {
      this.logError(`LedgerWatcher.snapshot failed for task ${this.taskId.toString()}; failing closed (paused=true)`, err);
      return failClosedSnapshot(this.taskId);
    }
  }

  /**
   * Polls `snapshot()` every `pollMs` (default 2000, roughly a block on a fast L2), calling
   * `onChange` once immediately and again whenever `charterVersion`, `paused`, `state`, or
   * `openEscalations` differs from the last snapshot seen. Returns a function that stops polling.
   */
  start(onChange: (s: LedgerSnapshot) => void, pollMs = 2000): () => void {
    let stopped = false;
    let last: { charterVersion: number; paused: boolean; state: string; openEscalations: number } | null = null;

    const poll = async (): Promise<void> => {
      const s = await this.snapshot();
      if (stopped) return;
      const key = { charterVersion: s.charterVersion, paused: s.paused, state: s.state, openEscalations: s.openEscalations };
      const changed =
        !last ||
        last.charterVersion !== key.charterVersion ||
        last.paused !== key.paused ||
        last.state !== key.state ||
        last.openEscalations !== key.openEscalations;
      if (changed) {
        last = key;
        onChange(s);
      }
    };

    void poll();
    const handle = setInterval(() => {
      void poll();
    }, pollMs);

    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }
}
