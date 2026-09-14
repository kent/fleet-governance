import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { TaskState } from "@fleet/sdk";
import { payloadHashForAction, payloadHashForPath } from "@fleet/sdk";
import type { TaskView } from "@fleet/sdk";
import type { CharterV1, DecisionV1 } from "@fleet/schemas";
import { describeAction } from "@fleet/gateway";
import type { DraftProposal } from "@fleet/gateway";
import { ScriptedProvider } from "./providers/scripted.js";
import type { ToolCall, ToolResult } from "./sandbox/tools.js";
import { StepBoard } from "./coordinator.js";
import { TaskLoop } from "./taskloop.js";
import type { ObjectionRecord, RecordedDecision, TaskLoopEvent, ToolExecutor } from "./taskloop.js";

const CHARTER: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "Make the provided test suite pass without modifying test files.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests"],
  forbiddenActions: ["modify_tests"],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 2_000_000 },
  stopConditions: ["tests_pass"],
};

const READ: ToolCall = { class: "read_repo", target: "src/sum.ts", args: {} };
const FETCH: ToolCall = { class: "network_fetch", target: "examples.internal", args: { path: "/cases" } };
const RUN_TESTS: ToolCall = { class: "run_tests", target: "npm test", args: {} };

function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 7n,
    operator: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address,
    createdAt: 100n,
    expiresAt: 7300n,
    state: TaskState.Open,
    charterVersion: 1,
    charterHash: ("0x" + "11".repeat(32)) as Hex,
    decisionCount: 0,
    openEscalations: 0,
    charterText: JSON.stringify(CHARTER),
    charter: CHARTER,
    ...overrides,
  };
}

/** A `task()` reader over a mutable view, so a test can flip state or bump a counter mid-run. */
function taskReader(initial: TaskView = taskView()): { read: () => Promise<TaskView>; view: TaskView; reads: number } {
  const state = { read: async () => state.view, view: initial, reads: 0 };
  state.read = async () => {
    state.reads += 1;
    return state.view;
  };
  return state;
}

function draftFor(tool: ToolCall): DraftProposal {
  return {
    kind: "GRANT_EXCEPTION",
    payloadHash: payloadHashForAction(describeAction(tool)),
    summary: `Grant exception: ${tool.class} ${tool.target}`,
  };
}

function blockedResult(tool: ToolCall): ToolResult {
  return {
    ok: false,
    blocked: {
      verdict: "BLOCK",
      reason: "target_not_allowlisted",
      payloadHash: payloadHashForAction(describeAction(tool)),
      draft: draftFor(tool),
    },
  };
}

function budgetBlockedResult(tool: ToolCall): ToolResult {
  return {
    ok: false,
    blocked: {
      verdict: "BLOCK",
      reason: "budget_exhausted",
      payloadHash: payloadHashForAction(describeAction(tool)),
      draft: null,
    },
  };
}

class FakeTools implements ToolExecutor {
  readonly calls: ToolCall[] = [];
  private readonly respond: (tc: ToolCall, n: number) => ToolResult;

  constructor(respond: (tc: ToolCall, n: number) => ToolResult) {
    this.respond = respond;
  }

  async call(tc: ToolCall): Promise<ToolResult> {
    this.calls.push(tc);
    return this.respond(tc, this.calls.length);
  }

  usage(): { toolCalls: number } {
    return { toolCalls: this.calls.length };
  }
}

type PromptKind = "step" | "objection" | "block";

/** A `ScriptedProvider` that answers by prompt kind. Each queue's last entry repeats once the
 *  queue is drained, so a loop bounded by `maxSteps` stays deterministic. A raw string is returned
 *  verbatim (that is how a test scripts malformed output); anything else is JSON-encoded. */
function scripted(script: Partial<Record<PromptKind, unknown[]>>): {
  provider: ScriptedProvider;
  prompts: PromptKind[];
} {
  const prompts: PromptKind[] = [];
  const queues: Record<PromptKind, unknown[]> = {
    step: [...(script.step ?? [])],
    objection: [...(script.objection ?? [])],
    block: [...(script.block ?? [])],
  };
  const provider = new ScriptedProvider(({ user }) => {
    const kind: PromptKind = user.includes("# Choose the next step")
      ? "step"
      : user.includes("# Object to the proposed next step")
        ? "objection"
        : "block";
    prompts.push(kind);
    const queue = queues[kind];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) return { raw: "not json at all" };
    return { raw: typeof next === "string" ? next : JSON.stringify(next) };
  });
  return { provider, prompts };
}

function collector(): {
  objections: { record(o: ObjectionRecord): void };
  recorded: ObjectionRecord[];
  events: TaskLoopEvent[];
  log: (e: TaskLoopEvent) => void;
  proposals: DecisionV1[];
  propose: (d: DecisionV1) => Promise<bigint>;
} {
  const recorded: ObjectionRecord[] = [];
  const events: TaskLoopEvent[] = [];
  const proposals: DecisionV1[] = [];
  return {
    recorded,
    events,
    proposals,
    objections: {
      record(o) {
        recorded.push(o);
      },
    },
    log: (e) => {
      events.push(e);
    },
    propose: async (d) => {
      proposals.push(d);
      return BigInt(100 + proposals.length);
    },
  };
}

function eventTypes(events: TaskLoopEvent[]): string[] {
  return events.map((e) => e.type);
}

describe("TaskLoop, coordinator, gateway blocks", () => {
  it("proposes exactly once per charter version for the same blocked descriptor", async () => {
    const task = taskReader();
    const tools = new FakeTools((tc) => blockedResult(tc));
    const sink = collector();
    const { provider } = scripted({
      step: [{ tool: FETCH, why: "the reference cases are not in the repository" }],
      block: [{ choice: "propose", rationale: "the task cannot be finished without the cases" }],
    });
    // Every read shows one more recorded decision, so the retry rule's "wait for a decision"
    // condition is satisfied and the second attempt does reach the gateway.
    const bumping = {
      read: async () => {
        task.view = { ...task.view, decisionCount: task.view.decisionCount + 1 };
        return task.view;
      },
    };

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: bumping.read,
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 5,
      log: sink.log,
    });
    const result = await loop.run(new AbortController().signal);

    expect(sink.proposals).toHaveLength(1);
    expect(sink.proposals[0]?.kind).toBe("GRANT_EXCEPTION");
    expect(sink.proposals[0]?.expectedVersion).toBe(1);
    expect(result.proposed).toEqual([101n]);
    expect(eventTypes(sink.events)).toContain("duplicate_suppressed");
    expect(result.blocked).toBe(2);
  });

  it("proposes again after the charter version changes", async () => {
    const task = taskReader();
    let reads = 0;
    const read = async (): Promise<TaskView> => {
      reads += 1;
      return { ...task.view, charterVersion: reads <= 1 ? 1 : 2, decisionCount: reads };
    };
    const tools = new FakeTools((tc) => blockedResult(tc));
    const sink = collector();
    const { provider } = scripted({
      step: [{ tool: FETCH, why: "the reference cases are not in the repository" }],
      block: [{ choice: "propose", rationale: "the task cannot be finished without the cases" }],
    });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: read,
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 2,
      log: sink.log,
    });
    await loop.run(new AbortController().signal);

    expect(sink.proposals.map((p) => p.expectedVersion)).toEqual([1, 2]);
  });

  it("refuses a third attempt at the same blocked descriptor locally, without touching the gateway", async () => {
    let reads = 0;
    const read = async (): Promise<TaskView> => {
      reads += 1;
      return taskView({ decisionCount: reads });
    };
    const tools = new FakeTools((tc) => blockedResult(tc));
    const sink = collector();
    const { provider } = scripted({
      step: [{ tool: FETCH, why: "the reference cases are not in the repository" }],
      block: [{ choice: "propose", rationale: "the task cannot be finished without the cases" }],
    });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: read,
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 4,
      log: sink.log,
    });
    await loop.run(new AbortController().signal);

    expect(tools.calls).toHaveLength(2);
    expect(eventTypes(sink.events)).toContain("retry_limit");
  });

  it("drops a blocked action on choice drop: nothing executes, nothing is proposed", async () => {
    const tools = new FakeTools((tc) => blockedResult(tc));
    const sink = collector();
    const { provider } = scripted({
      step: [{ tool: FETCH, why: "the reference cases are not in the repository" }],
      block: [{ choice: "drop", rationale: "the repository alone is enough to finish the task" }],
    });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 1,
      log: sink.log,
    });
    const result = await loop.run(new AbortController().signal);

    expect(sink.proposals).toHaveLength(0);
    expect(result.proposed).toEqual([]);
    expect(tools.calls.filter((c) => c.class !== "network_fetch")).toHaveLength(0);
    expect(eventTypes(sink.events)).toContain("block_dropped");
  });

  it("escalates to a human over the blocked action's own payload hash on choice escalate", async () => {
    const tools = new FakeTools((tc) => blockedResult(tc));
    const sink = collector();
    const { provider } = scripted({
      step: [{ tool: FETCH, why: "the reference cases are not in the repository" }],
      block: [{ choice: "escalate", rationale: "only the operator can say whether this host is acceptable" }],
    });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 1,
      log: sink.log,
    });
    await loop.run(new AbortController().signal);

    expect(sink.proposals).toHaveLength(1);
    expect(sink.proposals[0]?.kind).toBe("ESCALATE_TO_HUMAN");
    expect(sink.proposals[0]?.payloadHash).toBe(payloadHashForAction(describeAction(FETCH)));
  });

  it("never prompts on a block that carries no draft, and stops on an exhausted budget", async () => {
    const tools = new FakeTools((tc) => budgetBlockedResult(tc));
    const sink = collector();
    const { provider, prompts } = scripted({
      step: [{ tool: READ, why: "read the failing module" }],
    });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 5,
      log: sink.log,
    });
    const result = await loop.run(new AbortController().signal);

    expect(prompts).toEqual(["step"]);
    expect(result.stopReason).toBe("budget");
    expect(eventTypes(sink.events)).toContain("block_no_draft");
  });
});

describe("TaskLoop, coordinator, stopping", () => {
  it("stops when the task is no longer Open, as a recorded STOP_TASK leaves it", async () => {
    const task = taskReader();
    let reads = 0;
    const read = async (): Promise<TaskView> => {
      reads += 1;
      return reads === 1 ? task.view : { ...task.view, state: TaskState.Stopped };
    };
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({ step: [{ tool: READ, why: "read the failing module" }] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: read,
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 10,
      log: sink.log,
    });
    const result = await loop.run(new AbortController().signal);

    expect(result.stopReason).toBe("task_not_open");
    expect(result.steps).toBe(1);
    expect(tools.calls).toHaveLength(1);
  });

  it("stops with testsPassed when run_tests reports a passing suite", async () => {
    const tools = new FakeTools(() => ({ ok: true, output: JSON.stringify({ passed: true, output: "3 passing" }) }));
    const sink = collector();
    const { provider } = scripted({ step: [{ tool: RUN_TESTS, why: "check whether the suite is green" }] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 10,
      log: sink.log,
    });
    const result = await loop.run(new AbortController().signal);

    expect(result.testsPassed).toBe(true);
    expect(result.stopReason).toBe("tests_passed");
    expect(tools.calls).toHaveLength(1);
  });

  it("keeps going when run_tests reports a failing suite", async () => {
    const tools = new FakeTools(() => ({ ok: true, output: JSON.stringify({ passed: false, output: "1 failing" }) }));
    const sink = collector();
    const { provider } = scripted({ step: [{ tool: RUN_TESTS, why: "check whether the suite is green" }] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 3,
      log: sink.log,
    });
    const result = await loop.run(new AbortController().signal);

    expect(result.testsPassed).toBe(false);
    expect(result.stopReason).toBe("max_steps");
    expect(result.steps).toBe(3);
  });

  it("counts a malformed next-step as a step, takes no tool call, and does not crash", async () => {
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({ step: ["{ not valid json"] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 2,
      log: sink.log,
    });
    const result = await loop.run(new AbortController().signal);

    expect(tools.calls).toHaveLength(0);
    expect(result.steps).toBe(2);
    expect(result.stopReason).toBe("max_steps");
    expect(eventTypes(sink.events)).toContain("inference_failed");
  });

  it("stops when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({ step: [{ tool: READ, why: "read the failing module" }] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board: new StepBoard(),
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 5,
      log: sink.log,
    });
    const result = await loop.run(controller.signal);

    expect(result.stopReason).toBe("aborted");
    expect(tools.calls).toHaveLength(0);
  });
});

describe("TaskLoop, coordinator, the board and adoption", () => {
  it("publishes its model-chosen step to the board before executing it", async () => {
    const board = new StepBoard();
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({ step: [{ tool: READ, why: "read the failing module" }] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board,
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 1,
      log: sink.log,
    });
    await loop.run(new AbortController().signal);

    expect(board.history()).toHaveLength(1);
    expect(board.latest()?.source).toBe("model");
    expect(board.latest()?.tool).toEqual(READ);
    expect(board.latest()?.agentId).toBe(1);
    expect(tools.calls[0]).toEqual(READ);
  });

  it("keeps taking its own in-charter step while an objection's vote is still pending", async () => {
    const board = new StepBoard();
    const objected = board.publish({ agentId: 1, tool: READ, why: "read the failing module", seq: 1 });
    board.recordAlternative({
      agentId: 2,
      step: objected,
      alternative: FETCH,
      payloadHash: payloadHashForPath(describeAction(FETCH)),
      charterVersion: 1,
      proposalId: 55n,
    });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({ step: [{ tool: READ, why: "keep reading while the vote runs" }] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board,
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 1,
      // No decision recorded yet: the vote is still open.
      decisions: async () => [],
      log: sink.log,
    });
    await loop.run(new AbortController().signal);

    expect(board.latest()?.seq).toBe(2);
    expect(board.latest()?.source).toBe("model");
    expect(board.latest()?.tool).toEqual(READ);
    expect(board.pendingAlternatives()).toHaveLength(1);
  });

  it("adopts a recorded CHOOSE_PATH deterministically, with no model call for that step", async () => {
    const board = new StepBoard();
    const objected = board.publish({ agentId: 1, tool: READ, why: "read the failing module", seq: 1 });
    const payloadHash = payloadHashForPath(describeAction(FETCH));
    board.recordAlternative({
      agentId: 2,
      step: objected,
      alternative: FETCH,
      payloadHash,
      charterVersion: 1,
      proposalId: 55n,
    });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider, prompts } = scripted({ step: [{ tool: READ, why: "should never be asked" }] });

    const loop = new TaskLoop({
      agentId: 1,
      role: "planner",
      provider,
      tools,
      board,
      isCoordinator: true,
      task: async () => taskView(),
      propose: sink.propose,
      objections: sink.objections,
      maxSteps: 1,
      decisions: async (): Promise<RecordedDecision[]> => [
        { kind: "CHOOSE_PATH", payloadHash, charterVersion: 1 },
      ],
      log: sink.log,
    });
    await loop.run(new AbortController().signal);

    expect(prompts).toEqual([]);
    expect(board.latest()?.source).toBe("adopted_path");
    expect(board.latest()?.tool).toEqual(FETCH);
    expect(tools.calls[0]).toEqual(FETCH);
    expect(board.pendingAlternatives()).toHaveLength(0);
    expect(eventTypes(sink.events)).toContain("adopted_path");
  });
});

describe("TaskLoop, follower", () => {
  function followerLoop(opts: {
    board: StepBoard;
    provider: ScriptedProvider;
    tools: ToolExecutor;
    sink: ReturnType<typeof collector>;
    maxSteps?: number;
  }): TaskLoop {
    return new TaskLoop({
      agentId: 2,
      role: "critic",
      provider: opts.provider,
      tools: opts.tools,
      board: opts.board,
      isCoordinator: false,
      task: async () => taskView(),
      propose: opts.sink.propose,
      objections: opts.sink.objections,
      maxSteps: opts.maxSteps ?? 1,
      log: opts.sink.log,
    });
  }

  it("turns an objection with an alternative into a CHOOSE_PATH over that alternative's hash", async () => {
    const board = new StepBoard();
    board.publish({ agentId: 1, tool: READ, why: "read the failing module", seq: 1 });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({
      objection: [{ objects: true, alternative: FETCH, why: "the repository does not contain the reference cases" }],
    });

    const result = await followerLoop({ board, provider, tools, sink }).run(new AbortController().signal);

    expect(sink.proposals).toHaveLength(1);
    expect(sink.proposals[0]?.kind).toBe("CHOOSE_PATH");
    expect(sink.proposals[0]?.payloadHash).toBe(payloadHashForPath(describeAction(FETCH)));
    expect(sink.proposals[0]?.proposerAgentId).toBe(2);
    expect(result.objections).toBe(1);
  });

  it("does not execute a step it objected to, and leaves the alternative pending on the board", async () => {
    const board = new StepBoard();
    board.publish({ agentId: 1, tool: READ, why: "read the failing module", seq: 1 });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({
      objection: [{ objects: true, alternative: FETCH, why: "the repository does not contain the reference cases" }],
    });

    await followerLoop({ board, provider, tools, sink }).run(new AbortController().signal);

    expect(tools.calls).toHaveLength(0);
    expect(board.pendingAlternatives()).toHaveLength(1);
    expect(board.pendingAlternatives()[0]?.alternative).toEqual(FETCH);
    expect(board.pendingAlternatives()[0]?.proposalId).toBe(101n);
  });

  it("records every objection outcome, including a member that does not object", async () => {
    const board = new StepBoard();
    board.publish({ agentId: 1, tool: READ, why: "read the failing module", seq: 1 });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({
      objection: [{ objects: false, alternative: null, why: "the step is in charter and advances the goal" }],
    });

    const result = await followerLoop({ board, provider, tools, sink }).run(new AbortController().signal);

    expect(sink.recorded).toHaveLength(1);
    expect(sink.recorded[0]).toMatchObject({ agentId: 2, objects: false, alternative: null, proposalId: null });
    expect(sink.recorded[0]?.step.seq).toBe(1);
    expect(result.objections).toBe(0);
  });

  it("executes the coordinator's step in its own workspace when it does not object", async () => {
    const board = new StepBoard();
    board.publish({ agentId: 1, tool: READ, why: "read the failing module", seq: 1 });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({
      objection: [{ objects: false, why: "the step is in charter and advances the goal" }],
    });

    const result = await followerLoop({ board, provider, tools, sink }).run(new AbortController().signal);

    expect(tools.calls).toEqual([READ]);
    expect(sink.proposals).toHaveLength(0);
    expect(result.steps).toBe(1);
  });

  it("is blocked individually by its own gateway, and answers the block itself", async () => {
    const board = new StepBoard();
    board.publish({ agentId: 1, tool: FETCH, why: "fetch the reference cases", seq: 1 });
    const tools = new FakeTools((tc) => blockedResult(tc));
    const sink = collector();
    const { provider } = scripted({
      objection: [{ objects: false, why: "the coordinator's reasoning holds" }],
      block: [{ choice: "propose", rationale: "the fleet cannot finish without these cases" }],
    });

    const result = await followerLoop({ board, provider, tools, sink }).run(new AbortController().signal);

    expect(result.blocked).toBe(1);
    expect(sink.proposals[0]?.kind).toBe("GRANT_EXCEPTION");
    expect(sink.proposals[0]?.proposerAgentId).toBe(2);
  });

  it("executes an adopted path without asking for an objection to it", async () => {
    const board = new StepBoard();
    board.publish({ agentId: 1, tool: FETCH, why: "the fleet chose this path", seq: 1, source: "adopted_path" });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider, prompts } = scripted({
      objection: [{ objects: true, alternative: READ, why: "should never be asked" }],
    });

    await followerLoop({ board, provider, tools, sink }).run(new AbortController().signal);

    expect(prompts).toEqual([]);
    expect(tools.calls).toEqual([FETCH]);
    expect(sink.proposals).toHaveLength(0);
  });

  it("stops when the run is aborted while it waits for the coordinator", async () => {
    const controller = new AbortController();
    const board = new StepBoard();
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({ objection: [{ objects: false, why: "unused" }] });

    const pending = followerLoop({ board, provider, tools, sink, maxSteps: 5 }).run(controller.signal);
    controller.abort();
    const result = await pending;

    expect(result.stopReason).toBe("aborted");
    expect(tools.calls).toHaveLength(0);
  });

  it("executes the step when the objection inference fails, rather than recording a verdict it never got", async () => {
    const board = new StepBoard();
    board.publish({ agentId: 1, tool: READ, why: "read the failing module", seq: 1 });
    const tools = new FakeTools(() => ({ ok: true, output: "ok" }));
    const sink = collector();
    const { provider } = scripted({ objection: ["not json"] });

    await followerLoop({ board, provider, tools, sink }).run(new AbortController().signal);

    expect(sink.recorded).toHaveLength(0);
    expect(eventTypes(sink.events)).toContain("inference_failed");
    expect(tools.calls).toEqual([READ]);
  });
});
