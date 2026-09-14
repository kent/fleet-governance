import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { describeAction } from "@fleet/gateway";
import { payloadHashForPath } from "@fleet/sdk";
import type { ToolCall } from "./sandbox/tools.js";
import { StepBoard, pickCoordinator } from "./coordinator.js";

const READ: ToolCall = { class: "read_repo", target: "src/sum.ts", args: {} };
const WRITE: ToolCall = { class: "write_repo", target: "src/sum.ts", args: { content: "export {};\n" } };

function board(): StepBoard {
  return new StepBoard();
}

describe("StepBoard.publish", () => {
  it("stamps the step with a publish time and a default source of model", () => {
    const b = board();
    const before = Date.now();
    const step = b.publish({ agentId: 1, tool: READ, why: "read the failing module first", seq: 1 });
    expect(step.source).toBe("model");
    expect(step.publishedAt).toBeGreaterThanOrEqual(before);
    expect(step.tool).toEqual(READ);
  });

  it("keeps an explicit adopted_path source", () => {
    const b = board();
    const step = b.publish({ agentId: 1, tool: READ, why: "the fleet chose this path", seq: 1, source: "adopted_path" });
    expect(step.source).toBe("adopted_path");
  });

  it("refuses a sequence number that does not advance", () => {
    const b = board();
    b.publish({ agentId: 1, tool: READ, why: "first", seq: 2 });
    expect(() => b.publish({ agentId: 1, tool: WRITE, why: "second", seq: 2 })).toThrow(/seq/);
    expect(() => b.publish({ agentId: 1, tool: WRITE, why: "second", seq: 1 })).toThrow(/seq/);
  });
});

describe("StepBoard.latest and history", () => {
  it("reports no latest step on an empty board", () => {
    expect(board().latest()).toBeNull();
  });

  it("reports the most recent step and the full history in publish order", () => {
    const b = board();
    b.publish({ agentId: 1, tool: READ, why: "first", seq: 1 });
    b.publish({ agentId: 1, tool: WRITE, why: "second", seq: 2 });
    expect(b.latest()?.why).toBe("second");
    expect(b.history().map((s) => s.seq)).toEqual([1, 2]);
  });

  it("hands out a copy of the history, so a caller cannot rewrite the record", () => {
    const b = board();
    b.publish({ agentId: 1, tool: READ, why: "first", seq: 1 });
    b.history().push({ agentId: 9, tool: WRITE, why: "forged", seq: 99, publishedAt: 0, source: "model" });
    expect(b.history()).toHaveLength(1);
  });
});

describe("StepBoard.waitForNext", () => {
  it("resolves at once with the earliest step after afterSeq that is already published", async () => {
    const b = board();
    b.publish({ agentId: 1, tool: READ, why: "first", seq: 1 });
    b.publish({ agentId: 1, tool: WRITE, why: "second", seq: 2 });
    const step = await b.waitForNext(0, new AbortController().signal);
    expect(step?.seq).toBe(1);
  });

  it("resolves when the next step is published", async () => {
    const b = board();
    const pending = b.waitForNext(0, new AbortController().signal);
    b.publish({ agentId: 1, tool: READ, why: "first", seq: 1 });
    expect((await pending)?.why).toBe("first");
  });

  it("returns null when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await board().waitForNext(0, controller.signal)).toBeNull();
  });

  it("returns null when the signal aborts while waiting", async () => {
    const controller = new AbortController();
    const pending = board().waitForNext(0, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
  });

  it("returns null to everyone once the board is closed, so no follower waits forever", async () => {
    const b = board();
    const pending = b.waitForNext(0, new AbortController().signal);
    b.close();
    expect(await pending).toBeNull();
    expect(await b.waitForNext(0, new AbortController().signal)).toBeNull();
  });
});

describe("StepBoard alternatives", () => {
  const payloadHash = payloadHashForPath(describeAction(WRITE)) as Hex;

  function withAlternative(): StepBoard {
    const b = board();
    const step = b.publish({ agentId: 1, tool: READ, why: "first", seq: 1 });
    b.recordAlternative({ agentId: 2, step, alternative: WRITE, payloadHash, charterVersion: 1, proposalId: 11n });
    return b;
  }

  it("carries a follower's proposed alternative to the coordinator", () => {
    const pending = withAlternative().pendingAlternatives();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.alternative).toEqual(WRITE);
    expect(pending[0]?.payloadHash).toBe(payloadHash);
    expect(pending[0]?.proposalId).toBe(11n);
  });

  it("drops an alternative once it has been adopted, so it is never adopted twice", () => {
    const b = withAlternative();
    b.markAdopted(payloadHash);
    expect(b.pendingAlternatives()).toHaveLength(0);
  });

  it("ignores markAdopted for a hash it never saw", () => {
    const b = withAlternative();
    b.markAdopted(("0x" + "cc".repeat(32)) as Hex);
    expect(b.pendingAlternatives()).toHaveLength(1);
  });

  it("drops an alternative whose charter version has been superseded", () => {
    const b = withAlternative();
    b.dropSupersededAlternatives(1);
    expect(b.pendingAlternatives()).toHaveLength(1);
    b.dropSupersededAlternatives(2);
    expect(b.pendingAlternatives()).toHaveLength(0);
  });
});

describe("StepBoard memory bounds", () => {
  it("keeps only the most recent 500 steps, and still refuses a stale seq", () => {
    const b = board();
    for (let seq = 1; seq <= 600; seq++) {
      b.publish({ agentId: 1, tool: READ, why: `step ${seq}`, seq });
    }
    const history = b.history();
    expect(history).toHaveLength(500);
    expect(history[0]?.seq).toBe(101);
    expect(b.latest()?.seq).toBe(600);
    expect(() => b.publish({ agentId: 1, tool: READ, why: "stale", seq: 600 })).toThrow(/seq/);
  });

  it("still resolves a waiter after trimming, using the sequence number it was given", async () => {
    const b = board();
    for (let seq = 1; seq <= 600; seq++) {
      b.publish({ agentId: 1, tool: READ, why: `step ${seq}`, seq });
    }
    const step = await b.waitForNext(599, new AbortController().signal);
    expect(step?.seq).toBe(600);
  });
});

describe("pickCoordinator", () => {
  const members = [
    { agentId: 0, role: "engineer" },
    { agentId: 1, role: "Budget reviewer" },
    { agentId: 2, role: "planner" },
    { agentId: 3, role: "planner" },
  ];

  it("picks the first member whose role matches the fixture's coordinatorRole", () => {
    expect(pickCoordinator(members, "planner")).toBe(2);
  });

  it("slugs both sides, so spacing, case, and underscores never decide the coordinator", () => {
    expect(pickCoordinator(members, "budget-reviewer")).toBe(1);
    expect(pickCoordinator(members, "Budget_Reviewer")).toBe(1);
    expect(pickCoordinator(members, "  BUDGET REVIEWER  ")).toBe(1);
  });

  it("falls back to agent 0 when no member carries the named role", () => {
    expect(pickCoordinator(members, "archivist")).toBe(0);
  });

  it("falls back to agent 0 for an empty fleet rather than throwing", () => {
    expect(pickCoordinator([], "planner")).toBe(0);
  });

  it("returns the member's own agent id, not its index in the list", () => {
    expect(pickCoordinator([{ agentId: 4, role: "planner" }], "planner")).toBe(4);
  });
});
