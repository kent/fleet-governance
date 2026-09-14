import type { Hex } from "viem";
import { roleSlug } from "./providers/prompts.js";
import type { ToolCall } from "./sandbox/tools.js";

/**
 * One step on the shared task board (spec 10.3): the tool call the coordinator intends to take
 * next, why, and where it came from. `source` is `"model"` for a step the coordinator's provider
 * chose and `"adopted_path"` for one this code published deterministically because a `CHOOSE_PATH`
 * decision was recorded for it; no model call happens for the second kind, which is what makes an
 * adopted path auditable as a consequence of the vote rather than of a prompt.
 */
export type Step = {
  agentId: number;
  tool: ToolCall;
  why: string;
  seq: number;
  publishedAt: number;
  source: "model" | "adopted_path";
};

/**
 * A follower's objection alternative, waiting on the fleet's vote. The board carries these so the
 * coordinator (a different `TaskLoop` instance in the same process) can recognize the alternative
 * behind a recorded `CHOOSE_PATH` payload hash and publish it as the next step. `proposalId` is
 * null when no proposal was actually submitted (a duplicate suppressed locally, say).
 */
export type PendingAlternative = {
  agentId: number;
  step: Step;
  alternative: ToolCall;
  payloadHash: Hex;
  charterVersion: number;
  proposalId: bigint | null;
};

type Waiter = { afterSeq: number; resolve: (step: Step | null) => void };

/**
 * How many steps the board keeps. A long task would otherwise hold every step it ever published
 * for the life of the process, and the Runner writes `history()` into `record.json`. Followers
 * track their position by sequence number, not by index, so trimming the front changes nothing
 * for them: the only steps dropped are ones every follower has long passed.
 */
const MAX_STEPS_KEPT = 500;

/**
 * The fleet's shared step board: offchain, in process (every agent loop for one task runs inside
 * one Runner process in v1), and logged into the experiment record as `history()`.
 *
 * One writer (the coordinator) publishes; every follower reads. `waitForNext` is the follower's
 * side of that: it resolves with the first step after `afterSeq`, whether that step is already on
 * the board or arrives later, and resolves `null` when the run is aborted or the board is closed,
 * so a follower never blocks forever on a coordinator that has already stopped.
 */
export class StepBoard {
  private readonly steps: Step[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly alternatives: PendingAlternative[] = [];
  private closed = false;
  /** Tracked separately from `steps`, which is trimmed: a sequence number never goes backwards,
   *  even once the step that used it has aged out of the history. */
  private highestSeq = 0;

  /**
   * Adds a step to the board and wakes every follower waiting for it. Returns the stamped step so
   * the caller can log exactly what went on the board (a small widening of the brief's `void`).
   * Throws when `seq` does not advance: followers identify steps by sequence number, so a repeated
   * or decreasing one would silently make a step invisible to whoever had already passed it.
   */
  publish(step: { agentId: number; tool: ToolCall; why: string; seq: number; source?: Step["source"] }): Step {
    if (step.seq <= this.highestSeq) {
      throw new Error(`StepBoard.publish: seq ${step.seq} does not advance past the last published seq ${this.highestSeq}`);
    }
    this.highestSeq = step.seq;
    const published: Step = {
      agentId: step.agentId,
      tool: step.tool,
      why: step.why,
      seq: step.seq,
      publishedAt: Date.now(),
      source: step.source ?? "model",
    };
    this.steps.push(published);
    if (this.steps.length > MAX_STEPS_KEPT) this.steps.splice(0, this.steps.length - MAX_STEPS_KEPT);

    const woken = this.waiters.filter((w) => published.seq > w.afterSeq);
    for (const waiter of woken) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(published);
    }
    return published;
  }

  latest(): Step | null {
    return this.steps[this.steps.length - 1] ?? null;
  }

  /** A copy: the board's own record of the run cannot be edited by a reader. */
  history(): Step[] {
    return [...this.steps];
  }

  /**
   * Resolves with the earliest step whose `seq` is greater than `afterSeq`, waiting for one to be
   * published if none is on the board yet. Resolves `null` if `signal` is or becomes aborted, or
   * if the board is closed: a follower treats null as "stop waiting", never as a step.
   */
  waitForNext(afterSeq: number, signal: AbortSignal): Promise<Step | null> {
    const already = this.steps.find((s) => s.seq > afterSeq);
    if (already) return Promise.resolve(already);
    if (this.closed || signal.aborted) return Promise.resolve(null);

    return new Promise<Step | null>((resolve) => {
      const waiter: Waiter = {
        afterSeq,
        resolve: (step) => {
          signal.removeEventListener("abort", onAbort);
          resolve(step);
        },
      };
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        waiter.resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /** Wakes every waiting follower with `null` and makes every later wait return `null` at once.
   *  The Runner calls this when the task is over, so a follower loop cannot outlive the run. */
  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve(null);
    }
  }

  /** Records the alternative behind a `CHOOSE_PATH` proposal, so the coordinator can adopt it if
   *  and when that decision is recorded on chain. */
  recordAlternative(alternative: PendingAlternative): void {
    this.alternatives.push(alternative);
  }

  /** The alternatives still waiting on a decision, oldest first. */
  pendingAlternatives(): PendingAlternative[] {
    return [...this.alternatives];
  }

  /**
   * Drops every pending alternative proposed under a charter version older than `charterVersion`.
   * A `CHOOSE_PATH` carries `expectedVersion`, so once the charter is amended the ledger will
   * refuse the proposal behind that alternative; keeping it pending would leave the coordinator
   * waiting on a decision that can never be recorded, and the board holding it forever.
   */
  dropSupersededAlternatives(charterVersion: number): void {
    for (let i = this.alternatives.length - 1; i >= 0; i--) {
      if ((this.alternatives[i]?.charterVersion ?? charterVersion) < charterVersion) {
        this.alternatives.splice(i, 1);
      }
    }
  }

  /** Removes every pending alternative with this payload hash, once one has been adopted, so a
   *  standing `CHOOSE_PATH` decision cannot make the coordinator publish the same path forever. */
  markAdopted(payloadHash: Hex): void {
    const target = payloadHash.toLowerCase();
    for (let i = this.alternatives.length - 1; i >= 0; i--) {
      if ((this.alternatives[i]?.payloadHash ?? "").toLowerCase() === target) {
        this.alternatives.splice(i, 1);
      }
    }
  }
}

/**
 * Which member of a fleet drives the task loop as coordinator (spec 10.3), by role rather than by
 * position: the first member whose role slug equals the fixture's `coordinatorRole` slug, and
 * agent 0 when no member carries that role. Both sides go through `roleSlug`, so `"Budget
 * reviewer"` in a deploy manifest and `"budget-reviewer"` in a fixture name the same member.
 *
 * Returns an index into `members`, which the Runner builds in agent id order, so the return value
 * is the coordinator's agent id. Falling back to 0 rather than throwing is deliberate: a fixture
 * naming a role the deployed fleet does not have is a configuration mismatch worth a warning, not
 * a reason to refuse to run a fleet that is otherwise ready.
 */
export function pickCoordinator(members: readonly { agentId: number; role: string }[], coordinatorRole: string): number {
  const wanted = roleSlug(coordinatorRole);
  const match = members.find((m) => roleSlug(m.role) === wanted);
  return match ? match.agentId : 0;
}
