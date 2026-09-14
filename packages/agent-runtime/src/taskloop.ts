import type { Hex } from "viem";
import { BlockResponseV1, ObjectionV1, StepV1 } from "@fleet/schemas";
import type { CharterV1, DecisionKind, DecisionV1 } from "@fleet/schemas";
import { describeAction } from "@fleet/gateway";
import type { DraftProposal, GatewayVerdict } from "@fleet/gateway";
import { TaskState, payloadHashForAction } from "@fleet/sdk";
import type { TaskView } from "@fleet/sdk";
import { withOneRepair } from "./providers/types.js";
import type { CompleteRequest, CompleteResult, Provider } from "./providers/types.js";
import { DEFAULT_VOTE_OR_STEP_MAX_TOKENS } from "./providers/openrouter.js";
import { buildBlockResponsePrompt, buildNextStepPrompt, buildObjectionPrompt, untrusted } from "./providers/prompts.js";
import type { RunTestsOutput, ToolCall, ToolResult } from "./sandbox/tools.js";
import type { Step, StepBoard } from "./coordinator.js";
import { escalationDraft, toDecision } from "./divergence.js";
import type { Divergence } from "./divergence.js";

/** Spec 10.6: 60 seconds per inference. */
export const TASK_LOOP_TIMEOUT_MS = 60_000;

/** How many of the agent's own tool results go into the next-step prompt (controller notes). */
const RECENT_TOOL_RESULTS = 10;

/** How many of those keep a full output excerpt; older ones stay as one-line outcomes. */
const RECENT_TOOL_OUTPUTS = 3;

/** Characters of a tool's output carried into the prompt, before `... [truncated]`. */
const MAX_OUTPUT_EXCERPT_CHARS = 2000;

/** How many board steps go into the next-step prompt (controller notes). */
const RECENT_BOARD_STEPS = 3;

/** How many workspace paths the file listing carries. */
const MAX_LISTED_FILES = 200;

/** Default pause after a blocked, refused, or failed iteration, so a paused task or a standing
 *  refusal does not spend the whole step budget spinning. Tests pass 0. */
export const DEFAULT_BLOCKED_BACKOFF_MS = 2000;

/** Only these classes return content worth quoting back to the model; a `write_repo` result is
 *  `wrote <path>` and a `package_install` result is an installer transcript. */
const OUTPUT_EXCERPT_CLASSES: ReadonlySet<string> = new Set(["read_repo", "run_tests"]);

/**
 * The slice of `ToolRouter` a loop uses. Named separately so a test can pass a plain object (the
 * same reason `@fleet/gateway` declares `LedgerClient` rather than requiring a whole
 * `FleetClient`); every real `ToolRouter` satisfies it structurally.
 *
 * `signal` is optional and a real `ToolRouter` currently ignores it (the Runner can add
 * cancellation later); the loop still refuses to start a call once the signal is aborted, so an
 * aborted run never begins new work either way. `listFiles` is optional because only the Runner
 * can supply it: `ToolRouter` keeps its `Workspace` private, so the Runner passes
 * `() => workspace.listFiles()` alongside the router.
 */
export type ToolExecutor = {
  call(tc: ToolCall, signal?: AbortSignal): Promise<ToolResult>;
  usage(): { toolCalls: number };
  listFiles?: () => Promise<string[]>;
};

/** One objection prompt's outcome, recorded whether or not the member objected, so the report can
 *  count dissent by role (spec 15.4). */
export type ObjectionRecord = {
  agentId: number;
  step: Step;
  objects: boolean;
  alternative: ToolCall | null;
  why: string;
  proposalId: bigint | null;
};

export type ObjectionSink = { record(o: ObjectionRecord): void };

/** What the loop needs to know about a decision the ledger has already recorded. The Runner builds
 *  these from `getDecisionTrace`. */
export type RecordedDecision = { kind: DecisionKind; payloadHash: Hex; charterVersion: number };

export type StopReason = "tests_passed" | "max_steps" | "budget" | "task_not_open" | "aborted";

export type TaskLoopResult = {
  steps: number;
  blocked: number;
  proposed: bigint[];
  testsPassed: boolean;
  objections: number;
  stopReason: StopReason;
};

/** Everything the loop logs, for the experiment record. Every branch of the loop that the notes
 *  describe as "logged" emits one of these; the default sink drops them. */
export type TaskLoopEvent =
  | { type: "step_published"; agentId: number; seq: number; tool: ToolCall; why: string; source: Step["source"] }
  | { type: "adopted_path"; agentId: number; seq: number; payloadHash: Hex; tool: ToolCall }
  | { type: "tool_result"; agentId: number; tool: ToolCall; ok: boolean; detail: string }
  | { type: "inference_failed"; agentId: number; prompt: "next_step" | "objection" | "block_response"; error: string }
  | { type: "blocked"; agentId: number; tool: ToolCall; reason: string; payloadHash: Hex; hasDraft: boolean }
  | { type: "block_no_draft"; agentId: number; tool: ToolCall; reason: string }
  | { type: "block_dropped"; agentId: number; tool: ToolCall; rationale: string }
  | { type: "objection"; agentId: number; seq: number; objects: boolean; why: string }
  | {
      type: "proposed";
      agentId: number;
      kind: DecisionKind;
      payloadHash: Hex;
      charterVersion: number;
      proposalId: bigint;
    }
  | { type: "propose_failed"; agentId: number; kind: DecisionKind; payloadHash: Hex; error: string }
  | { type: "duplicate_suppressed"; agentId: number; kind: DecisionKind; payloadHash: Hex; charterVersion: number }
  | { type: "retry_limit"; agentId: number; tool: ToolCall; payloadHash: Hex; charterVersion: number }
  | { type: "retry_pending_decision"; agentId: number; tool: ToolCall; payloadHash: Hex; charterVersion: number }
  | { type: "stopped"; agentId: number; reason: StopReason; steps: number };

export type TaskLoopOpts = {
  agentId: number;
  role: string;
  provider: Provider;
  tools: ToolExecutor;
  board: StepBoard;
  isCoordinator: boolean;
  /** The task as the ledger currently has it. Read once per iteration: it is the loop's view of
   *  state, charter, charter version, and decision count. */
  task: () => Promise<TaskView>;
  /** Hands a finished decision to the Runner's proposer path and resolves with its proposal id. */
  propose: (decision: DecisionV1) => Promise<bigint>;
  objections: ObjectionSink;
  maxSteps: number;
  /** Decisions already recorded on this task. Without it, no path is ever adopted. */
  decisions?: () => Promise<RecordedDecision[]>;
  log?: (event: TaskLoopEvent) => void;
  timeoutMs?: number;
  maxTokens?: number;
  /** Pause after an iteration that was blocked without a draft, refused locally, or lost its
   *  inference. Defaults to `DEFAULT_BLOCKED_BACKOFF_MS`; tests pass 0. */
  blockedBackoffMs?: number;
};

type ToolLine = { tool: ToolCall; ok: boolean; detail: string; output?: string };

/** One descriptor's block history at one charter version, for the retry rule. */
type Attempt = { attempts: number; decisionCountAtLastBlock: number };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toolLabel(tool: ToolCall): string {
  return `${tool.class} ${tool.target}`;
}

/** `untrusted()` renders the label into an XML-ish attribute, so a target carrying a quote or an
 *  angle bracket would otherwise let a file name reshape the prompt's own structure. */
function untrustedLabel(tool: ToolCall): string {
  return toolLabel(tool).replace(/["'<>\r\n]/g, " ");
}

/** The first `MAX_OUTPUT_EXCERPT_CHARS` characters of a tool's output, marked when cut. Measured
 *  in characters, not bytes: this bounds a prompt, not a chain field. */
function excerpt(output: string): string {
  return output.length <= MAX_OUTPUT_EXCERPT_CHARS
    ? output
    : `${output.slice(0, MAX_OUTPUT_EXCERPT_CHARS)}... [truncated]`;
}

function decodeRunTests(output: string): RunTestsOutput | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as RunTestsOutput).passed === "boolean") {
      return parsed as RunTestsOutput;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * `withOneRepair` is declared as returning `ReturnType<Provider["complete"]>`, which erases the
 * request's own type parameter to `unknown`. The value it carries was validated against
 * `req.schema` by the provider before it was returned, so this restores the type the request
 * already guarantees rather than asserting anything new about it.
 */
async function completeOnce<T>(provider: Provider, req: CompleteRequest<T>): Promise<CompleteResult<T>> {
  return (await withOneRepair(provider, req)) as CompleteResult<T>;
}

/**
 * One agent's task loop (spec 10.3). The coordinator asks its provider for the next step, publishes
 * it to the shared board, and executes it; every other member reads the coordinator's step, may
 * object to it, and otherwise executes it in its own workspace through its own gateway. Every
 * gateway block becomes a question for the model (adopt the gateway's draft, drop the action, or
 * escalate) and, deterministically, a `DecisionV1` for the Runner to propose.
 *
 * Nothing in here trusts model output with anything but content: which decision kind gets proposed
 * comes from the gateway's draft, every payload hash is computed here from the tool call, and the
 * retry and dedupe rules are this code's, not the model's.
 */
export class TaskLoop {
  private readonly opts: TaskLoopOpts;
  private readonly log: (event: TaskLoopEvent) => void;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly backoffMs: number;

  private steps = 0;
  private blockedCount = 0;
  private objectionCount = 0;
  private testsPassed = false;
  private readonly proposed: bigint[] = [];

  /** `${charterVersion}:${payloadHash}` -> block history, the retry rule's state. */
  private readonly attempts = new Map<string, Attempt>();
  /** `${charterVersion}:${kind}:${payloadHash}`, the proposal dedupe rule's state. */
  private readonly proposedKeys = new Set<string>();
  /** This agent's own recent tool results, newest last. */
  private readonly toolLines: ToolLine[] = [];
  /** Decisions read on the most recent iteration, for the next-step prompt. */
  private recentDecisions: RecordedDecision[] = [];
  /** The last board sequence number this loop has processed (followers only). */
  private lastSeq = 0;
  /** Set by an iteration that was blocked without a draft, refused locally, or lost its inference;
   *  `run` pauses for `blockedBackoffMs` before the next one. */
  private pendingBackoff = false;

  constructor(opts: TaskLoopOpts) {
    this.opts = opts;
    this.log = opts.log ?? ((): void => {});
    this.timeoutMs = opts.timeoutMs ?? TASK_LOOP_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_VOTE_OR_STEP_MAX_TOKENS;
    this.backoffMs = opts.blockedBackoffMs ?? DEFAULT_BLOCKED_BACKOFF_MS;
  }

  async run(signal: AbortSignal): Promise<TaskLoopResult> {
    let stopReason: StopReason | null = null;
    // Set before the first await: a follower joins the run where the board already is (it did not
    // exist for the steps before it started), and a step published between this line and the first
    // `waitForNext` is still delivered, because that call works from this sequence number.
    if (!this.opts.isCoordinator) this.lastSeq = this.opts.board.latest()?.seq ?? 0;

    while (stopReason === null) {
      if (signal.aborted) {
        stopReason = "aborted";
        break;
      }
      if (this.steps >= this.opts.maxSteps) {
        stopReason = "max_steps";
        break;
      }
      if (this.pendingBackoff) {
        this.pendingBackoff = false;
        await this.backoff(signal);
        if (signal.aborted) {
          stopReason = "aborted";
          break;
        }
      }

      const task = await this.opts.task();
      if (task.state !== TaskState.Open || task.charter === null) {
        // A stop decision, a completed or expired task, or a charter that no longer parses: there
        // is no in-charter work left to do either way.
        stopReason = "task_not_open";
        break;
      }

      stopReason = this.opts.isCoordinator
        ? await this.coordinatorIteration(task, task.charter, signal)
        : await this.followerIteration(task, task.charter, signal);
    }

    this.log({ type: "stopped", agentId: this.opts.agentId, reason: stopReason, steps: this.steps });
    return {
      steps: this.steps,
      blocked: this.blockedCount,
      proposed: [...this.proposed],
      testsPassed: this.testsPassed,
      objections: this.objectionCount,
      stopReason,
    };
  }

  // --- coordinator ---------------------------------------------------------------------------

  private async coordinatorIteration(task: TaskView, charter: CharterV1, signal: AbortSignal): Promise<StopReason | null> {
    this.recentDecisions = await this.readDecisions();
    if (signal.aborted) return "aborted";
    // An alternative proposed under an older charter version can no longer be recorded: its
    // proposal carries that version as `expectedVersion` and the ledger will refuse it.
    this.opts.board.dropSupersededAlternatives(task.charterVersion);

    const adopted = this.findAdoptedPath(task.charterVersion);
    if (adopted) {
      const step = this.publish(adopted.alternative, `Adopted the fleet's recorded CHOOSE_PATH decision.`, "adopted_path");
      this.opts.board.markAdopted(adopted.payloadHash);
      this.log({
        type: "adopted_path",
        agentId: this.opts.agentId,
        seq: step.seq,
        payloadHash: adopted.payloadHash,
        tool: adopted.alternative,
      });
      this.steps += 1;
      return this.executeStep(step.tool, task, charter, signal);
    }

    const prompt = buildNextStepPrompt({
      memberRole: this.opts.role,
      task,
      charter,
      recentActivity: await this.recentActivity(),
    });
    const result = await completeOnce(this.opts.provider, {
      system: prompt.system,
      user: prompt.user,
      schema: StepV1,
      maxTokens: this.maxTokens,
      timeoutMs: this.timeoutMs,
    });
    this.steps += 1;
    if (signal.aborted) return "aborted";
    if (!result.ok) {
      // Spec 10.6: malformed output is a worker failure, never a fabricated step. The iteration
      // is spent, the loop continues.
      this.log({ type: "inference_failed", agentId: this.opts.agentId, prompt: "next_step", error: result.error });
      this.pendingBackoff = true;
      return null;
    }

    const tool: ToolCall = result.value.tool;
    if (!this.mayAttempt(tool, task)) return null;

    const step = this.publish(tool, result.value.why, "model");
    return this.executeStep(step.tool, task, charter, signal);
  }

  /** The first pending alternative whose payload hash a `CHOOSE_PATH` recorded under the current
   *  charter version covers. A decision recorded under an older version is not adopted: the path it
   *  chose was judged against a charter the fleet has since replaced. */
  private findAdoptedPath(charterVersion: number): { alternative: ToolCall; payloadHash: Hex } | null {
    if (this.recentDecisions.length === 0) return null;
    const chosen = new Set(
      this.recentDecisions
        .filter((d) => d.kind === "CHOOSE_PATH" && d.charterVersion === charterVersion)
        .map((d) => d.payloadHash.toLowerCase()),
    );
    if (chosen.size === 0) return null;
    for (const pending of this.opts.board.pendingAlternatives()) {
      if (chosen.has(pending.payloadHash.toLowerCase())) {
        return { alternative: pending.alternative, payloadHash: pending.payloadHash };
      }
    }
    return null;
  }

  private publish(tool: ToolCall, why: string, source: Step["source"]): Step {
    const seq = (this.opts.board.latest()?.seq ?? 0) + 1;
    const step = this.opts.board.publish({ agentId: this.opts.agentId, tool, why, seq, source });
    this.log({
      type: "step_published",
      agentId: this.opts.agentId,
      seq: step.seq,
      tool: step.tool,
      why: step.why,
      source: step.source,
    });
    return step;
  }

  // --- follower ------------------------------------------------------------------------------

  private async followerIteration(task: TaskView, charter: CharterV1, signal: AbortSignal): Promise<StopReason | null> {
    const step = await this.opts.board.waitForNext(this.lastSeq, signal);
    if (!step) return "aborted";
    this.lastSeq = step.seq;
    this.steps += 1;

    // An adopted path is already the fleet's recorded decision; objecting to it again would only
    // re-propose what has been decided.
    if (step.source === "adopted_path") {
      return this.executeStep(step.tool, task, charter, signal);
    }

    const prompt = buildObjectionPrompt({
      memberRole: this.opts.role,
      task,
      charter,
      proposedStep: { tool: step.tool, why: step.why },
    });
    const result = await completeOnce(this.opts.provider, {
      system: prompt.system,
      user: prompt.user,
      schema: ObjectionV1,
      maxTokens: this.maxTokens,
      timeoutMs: this.timeoutMs,
    });
    if (signal.aborted) return "aborted";
    if (!result.ok) {
      // Nothing is recorded to the objection sink: an inference failure is not a member deciding
      // not to object, and the report must not count it as one. The step still runs, in this
      // agent's own workspace and through its own gateway.
      this.log({ type: "inference_failed", agentId: this.opts.agentId, prompt: "objection", error: result.error });
      this.pendingBackoff = true;
      return this.executeStep(step.tool, task, charter, signal);
    }

    const alternative: ToolCall | null = result.value.alternative ?? null;
    this.log({
      type: "objection",
      agentId: this.opts.agentId,
      seq: step.seq,
      objects: result.value.objects,
      why: result.value.why,
    });

    if (!result.value.objects || alternative === null) {
      // Objecting without naming an alternative leaves nothing to hash and nothing to choose, so
      // there is no CHOOSE_PATH to make of it; the objection is still recorded.
      this.opts.objections.record({
        agentId: this.opts.agentId,
        step,
        objects: result.value.objects,
        alternative,
        why: result.value.why,
        proposalId: null,
      });
      return this.executeStep(step.tool, task, charter, signal);
    }

    this.objectionCount += 1;

    // The charter may have been amended while the objection prompt was in flight. A decision built
    // from the version read at the top of the iteration would carry a stale `expectedVersion`, the
    // ledger would refuse it, and this follower has already advanced past the step, so the dissent
    // would be lost silently. Everything below is built from a view read right now.
    const fresh = await this.opts.task();
    if (signal.aborted) return "aborted";
    if (fresh.state !== TaskState.Open || fresh.charter === null) return "task_not_open";

    const divergence: Divergence = { source: "objection", agentId: this.opts.agentId, step, alternative };
    const decision = toDecision(divergence, {
      taskId: fresh.id,
      charterVersion: fresh.charterVersion,
      agentId: this.opts.agentId,
      charter: fresh.charter,
      rationale: result.value.why,
    });
    const proposalId = await this.maybePropose(decision, fresh.charterVersion);

    if (proposalId !== null) {
      // Only a live proposal can become a recorded decision, so only a live proposal leaves an
      // alternative for the coordinator to adopt. A duplicate-suppressed or failed one would sit
      // on the board forever waiting for a vote that was never opened.
      this.opts.board.recordAlternative({
        agentId: this.opts.agentId,
        step,
        alternative,
        payloadHash: decision.payloadHash as Hex,
        charterVersion: fresh.charterVersion,
        proposalId,
      });
    }
    this.opts.objections.record({
      agentId: this.opts.agentId,
      step,
      objects: true,
      alternative,
      why: result.value.why,
      proposalId,
    });
    // The objected step is not executed here: the alternative waits on the fleet's vote, and the
    // coordinator's own step proceeds in its own workspace if it is in charter (spec 10.3).
    return null;
  }

  // --- execution and blocks ------------------------------------------------------------------

  private async executeStep(tool: ToolCall, task: TaskView, charter: CharterV1, signal: AbortSignal): Promise<StopReason | null> {
    if (!this.mayAttempt(tool, task)) return null;
    // An aborted run starts no new work, whatever the executor does with the signal itself.
    if (signal.aborted) return "aborted";

    const result = await this.opts.tools.call(tool, signal);
    if (signal.aborted) return "aborted";

    if (result.ok) {
      this.recordToolLine(tool, true, "ok", result.output);
      if (tool.class === "run_tests") {
        const decoded = decodeRunTests(result.output);
        if (decoded?.passed) {
          this.testsPassed = true;
          return "tests_passed";
        }
      }
      return null;
    }

    if ("error" in result) {
      this.recordToolLine(tool, false, `error: ${result.error}`);
      return null;
    }

    return this.handleBlock(tool, result.blocked, task, charter, signal);
  }

  private async handleBlock(
    tool: ToolCall,
    verdict: GatewayVerdict & { verdict: "BLOCK" },
    task: TaskView,
    charter: CharterV1,
    signal: AbortSignal,
  ): Promise<StopReason | null> {
    this.blockedCount += 1;
    this.recordToolLine(
      tool,
      false,
      `blocked (${verdict.reason}, ${verdict.draft === null ? "no draft proposal" : "draft proposal available"})`,
    );
    this.recordBlockedAttempt(tool, task);
    this.log({
      type: "blocked",
      agentId: this.opts.agentId,
      tool,
      reason: verdict.reason,
      payloadHash: verdict.payloadHash,
      hasDraft: verdict.draft !== null,
    });

    if (verdict.reason === "budget_exhausted") {
      this.log({ type: "block_no_draft", agentId: this.opts.agentId, tool, reason: verdict.reason });
      return "budget";
    }
    if (verdict.draft === null) {
      // Escalated, paused, expired, or a task that is no longer open: no decision this fleet can
      // record would unblock it, so the model is never asked about it. A pause is only ever
      // visible here, since `TaskView` carries no pause flag, and it is worth waiting out rather
      // than spending an inference per iteration on a gateway that is refusing everything.
      this.log({ type: "block_no_draft", agentId: this.opts.agentId, tool, reason: verdict.reason });
      this.pendingBackoff = true;
      return null;
    }
    if (signal.aborted) return "aborted";

    const prompt = buildBlockResponsePrompt({
      memberRole: this.opts.role,
      task,
      charter,
      blockedTool: tool,
      blockReason: verdict.reason,
      draft: verdict.draft,
    });
    const result = await completeOnce(this.opts.provider, {
      system: prompt.system,
      user: prompt.user,
      schema: BlockResponseV1,
      maxTokens: this.maxTokens,
      timeoutMs: this.timeoutMs,
    });
    if (signal.aborted) return "aborted";
    if (!result.ok) {
      this.log({ type: "inference_failed", agentId: this.opts.agentId, prompt: "block_response", error: result.error });
      this.pendingBackoff = true;
      return null;
    }

    if (result.value.choice === "drop") {
      this.log({ type: "block_dropped", agentId: this.opts.agentId, tool, rationale: result.value.rationale });
      return null;
    }

    const draft: DraftProposal =
      result.value.choice === "escalate" ? escalationDraft(tool, verdict.draft) : verdict.draft;

    // Same reason as the objection path: an amendment landing during the block-response inference
    // would otherwise make this proposal stale on arrival.
    const fresh = await this.opts.task();
    if (signal.aborted) return "aborted";
    if (fresh.state !== TaskState.Open || fresh.charter === null) return "task_not_open";

    let decision: DecisionV1;
    try {
      decision = toDecision(
        { source: "gateway_block", agentId: this.opts.agentId, draft, blockedTool: tool },
        {
          taskId: fresh.id,
          charterVersion: fresh.charterVersion,
          agentId: this.opts.agentId,
          charter: fresh.charter,
          rationale: result.value.rationale,
        },
      );
    } catch (err) {
      // A draft this module refuses to turn into a decision (an `AMEND_CHARTER` with no charter
      // text behind its hash) is a gateway bug, not a reason to end the task.
      this.log({
        type: "propose_failed",
        agentId: this.opts.agentId,
        kind: draft.kind,
        payloadHash: draft.payloadHash,
        error: errorMessage(err),
      });
      return null;
    }
    await this.maybePropose(decision, fresh.charterVersion);
    return null;
  }

  // --- retry, dedupe, proposing ---------------------------------------------------------------

  private attemptKey(tool: ToolCall, charterVersion: number): string {
    return `${charterVersion}:${this.payloadHashFor(tool).toLowerCase()}`;
  }

  private payloadHashFor(tool: ToolCall): Hex {
    return payloadHashForAction(describeAction({ class: tool.class, target: tool.target, args: tool.args }));
  }

  /**
   * The retry rule (spec 10.3, "may not retry the same blocked action more than once per charter
   * version"), as the controller's notes pin it down: a blocked `(charterVersion, payloadHash)`
   * reaches the gateway at most twice, and the second time only once the loop has seen the task's
   * `decisionCount` rise, which is what "the fleet did something about it" looks like from here.
   * Any further attempt is refused locally: no gateway call, no budget spent.
   */
  private mayAttempt(tool: ToolCall, task: TaskView): boolean {
    const key = this.attemptKey(tool, task.charterVersion);
    const attempt = this.attempts.get(key);
    if (!attempt) return true;

    if (attempt.attempts >= 2) {
      this.log({
        type: "retry_limit",
        agentId: this.opts.agentId,
        tool,
        payloadHash: this.payloadHashFor(tool),
        charterVersion: task.charterVersion,
      });
      // Recorded as activity, not only as a log line: without it the prompt keeps showing the two
      // old blocks and nothing else, and the model asks for the same tool call every iteration
      // until the step budget runs out.
      this.recordToolLine(
        tool,
        false,
        `refused locally: retry limit reached for this action under charter version ${task.charterVersion}`,
      );
      this.pendingBackoff = true;
      return false;
    }
    if (task.decisionCount <= attempt.decisionCountAtLastBlock) {
      this.log({
        type: "retry_pending_decision",
        agentId: this.opts.agentId,
        tool,
        payloadHash: this.payloadHashFor(tool),
        charterVersion: task.charterVersion,
      });
      this.recordToolLine(tool, false, "refused locally: waiting for the fleet's decision on this action");
      this.pendingBackoff = true;
      return false;
    }
    return true;
  }

  private recordBlockedAttempt(tool: ToolCall, task: TaskView): void {
    const key = this.attemptKey(tool, task.charterVersion);
    const attempt = this.attempts.get(key) ?? { attempts: 0, decisionCountAtLastBlock: 0 };
    this.attempts.set(key, {
      attempts: attempt.attempts + 1,
      decisionCountAtLastBlock: task.decisionCount,
    });
  }

  /**
   * Proposes a decision unless this agent already proposed the same `(charterVersion, kind,
   * payloadHash)`. The dedupe key is recorded only once a proposal actually lands, so a proposal
   * that reverted can be attempted again within whatever the retry rule still allows.
   */
  private async maybePropose(decision: DecisionV1, charterVersion: number): Promise<bigint | null> {
    const payloadHash = decision.payloadHash as Hex;
    const key = `${charterVersion}:${decision.kind}:${payloadHash.toLowerCase()}`;
    if (this.proposedKeys.has(key)) {
      this.log({
        type: "duplicate_suppressed",
        agentId: this.opts.agentId,
        kind: decision.kind,
        payloadHash,
        charterVersion,
      });
      return null;
    }

    try {
      const proposalId = await this.opts.propose(decision);
      this.proposedKeys.add(key);
      this.proposed.push(proposalId);
      this.log({
        type: "proposed",
        agentId: this.opts.agentId,
        kind: decision.kind,
        payloadHash,
        charterVersion,
        proposalId,
      });
      return proposalId;
    } catch (err) {
      // A revert or an RPC failure is the Runner's problem to report, not a reason to end the
      // task: the loop keeps working within the charter.
      this.log({
        type: "propose_failed",
        agentId: this.opts.agentId,
        kind: decision.kind,
        payloadHash,
        error: errorMessage(err),
      });
      return null;
    }
  }

  // --- prompt context --------------------------------------------------------------------------

  private recordToolLine(tool: ToolCall, ok: boolean, detail: string, output?: string): void {
    const line: ToolLine =
      ok && output !== undefined && OUTPUT_EXCERPT_CLASSES.has(tool.class)
        ? { tool, ok, detail, output }
        : { tool, ok, detail };
    this.toolLines.push(line);
    if (this.toolLines.length > RECENT_TOOL_RESULTS) this.toolLines.shift();
    this.log({ type: "tool_result", agentId: this.opts.agentId, tool, ok, detail });
  }

  /** Waits `blockedBackoffMs`, or until the run is aborted, whichever comes first. */
  private async backoff(signal: AbortSignal): Promise<void> {
    if (this.backoffMs <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.backoffMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async readDecisions(): Promise<RecordedDecision[]> {
    const reader = this.opts.decisions;
    if (!reader) return [];
    try {
      return await reader();
    } catch {
      // A failed read means "nothing adopted this iteration", never a guess at what was decided.
      return [];
    }
  }

  /**
   * The next-step prompt's context: the workspace's file list, this agent's own recent tool
   * results (the last few with a bounded excerpt of what they returned), the board's last few
   * steps, and the decisions recorded on the task. Never vote tallies and never another member's
   * reasons (spec 10.5).
   *
   * Every excerpt goes through `untrusted()`: a file's contents, a test runner's output, and a
   * fetched page are all data, and a README that says "ignore the charter" is a README, not an
   * instruction. The whole `recentActivity` block is wrapped again by `buildNextStepPrompt`.
   */
  private async recentActivity(): Promise<string[]> {
    const lines: string[] = [];

    const files = await this.readFileList();
    if (files) {
      lines.push(`Files in your workspace (${files.length} shown, sorted):`);
      for (const file of files) lines.push(`- ${file}`);
    }

    if (this.toolLines.length > 0) {
      lines.push("Your recent tool calls (oldest first):");
      const firstExcerpt = Math.max(0, this.toolLines.length - RECENT_TOOL_OUTPUTS);
      this.toolLines.forEach((line, index) => {
        lines.push(`- ${toolLabel(line.tool)}: ${line.detail}`);
        if (line.output !== undefined && index >= firstExcerpt) {
          lines.push(untrusted(untrustedLabel(line.tool), excerpt(line.output)));
        }
      });
    }

    const steps = this.opts.board.history().slice(-RECENT_BOARD_STEPS);
    if (steps.length > 0) {
      lines.push("Recent steps on the shared board (oldest first):");
      for (const step of steps) {
        lines.push(`- step ${step.seq} by agent ${step.agentId} (${step.source}): ${toolLabel(step.tool)}`);
      }
    }

    if (this.recentDecisions.length > 0) {
      lines.push("Decisions recorded on this task:");
      for (const decision of this.recentDecisions) {
        lines.push(`- ${decision.kind} at charter version ${decision.charterVersion}, payload ${decision.payloadHash}`);
      }
    }

    return lines;
  }

  /** The workspace's paths, capped and sorted, or null when the executor offers no listing. Path
   *  names are metadata rather than file content, so the listing is not wrapped as untrusted; each
   *  entry is still flattened to a single line so a crafted name cannot fake extra structure. */
  private async readFileList(): Promise<string[] | null> {
    const reader = this.opts.tools.listFiles;
    if (!reader) return null;
    try {
      const files = await reader();
      return [...files]
        .sort()
        .slice(0, MAX_LISTED_FILES)
        .map((file) => file.replace(/[\r\n]+/g, " "));
    } catch {
      // A listing that cannot be read is simply absent from the prompt.
      return null;
    }
  }
}
