import { z } from "zod";

/**
 * Line shapes for the JSON-lines files a Runner run directory (`experiments/reports/<runId>/`)
 * accumulates while agents work: written by the pipeline (model-driven AGENTS_RUNNING, the
 * guardian route) and read by the Runner UI (live view, report). One strict shape per file, so a
 * reader can reject a line it does not understand instead of guessing. Chain integers travel as
 * decimal strings, hashes as 0x-prefixed hex, timestamps as ISO 8601. The append and read helpers
 * live in `apps/runner/src/pipeline/runfiles.ts`.
 */

const HexString = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-prefixed hex");
const Iso = z.string().min(1);

/** A raw tool call as an agent asked for it. `args` is opaque data, never interpreted here. */
export const ToolCallLine = z.object({ class: z.string().min(1), target: z.string(), args: z.unknown() }).strict();
export type ToolCallLine = z.infer<typeof ToolCallLine>;

/** One gateway verdict (`GatewayLogRecord` from `@fleet/gateway`, verbatim). File: `gateway.jsonl`. */
export const GatewayLogLine = z
  .object({
    ts: Iso,
    blockNumber: z.string().regex(/^\d+$/),
    taskId: z.string().regex(/^\d+$/),
    agentId: z.number().int().nonnegative(),
    charterVersion: z.number().int().positive(),
    descriptor: z.object({ class: z.string().min(1), target: z.string(), argsHash: HexString }).strict(),
    payloadHash: HexString,
    verdict: z.enum(["ALLOW", "BLOCK"]),
    reason: z.string().optional(),
    basis: z.string().optional(),
  })
  .strict();
export type GatewayLogLine = z.infer<typeof GatewayLogLine>;

/** One coordinator step as published to the board. File: `steps.jsonl`. */
export const StepLine = z
  .object({
    type: z.literal("step"),
    at: Iso,
    agentId: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    tool: ToolCallLine,
    why: z.string(),
    source: z.enum(["model", "adopted_path"]),
  })
  .strict();
export type StepLine = z.infer<typeof StepLine>;

/** One objection prompt's outcome, objected or not. File: `objections.jsonl`. */
export const ObjectionLine = z
  .object({
    type: z.literal("objection"),
    at: Iso,
    agentId: z.number().int().nonnegative(),
    seq: z.number().int().nonnegative(),
    objects: z.boolean(),
    alternative: ToolCallLine.nullable(),
    why: z.string(),
    proposalId: z.string().regex(/^\d+$/).nullable(),
  })
  .strict();
export type ObjectionLine = z.infer<typeof ObjectionLine>;

/** One guardian action taken through the Runner. File: `interventions.jsonl`. */
export const InterventionLine = z
  .object({
    type: z.literal("human_intervention"),
    at: Iso,
    action: z.enum(["pause", "unpause", "cancel"]),
    proposalId: z.string().regex(/^\d+$/).nullable(),
    txHash: HexString,
    blockNumber: z.string().regex(/^\d+$/),
    actor: z.literal("guardian"),
  })
  .strict();
export type InterventionLine = z.infer<typeof InterventionLine>;

/** One `TaskLoopEvent` from `@fleet/agent-runtime`, wrapped with a timestamp. Bigints inside the
 *  event are serialized as decimal strings by `appendJsonl`. File: `loop-events.jsonl`. */
export const LoopEventLine = z
  .object({
    type: z.literal("loop_event"),
    at: Iso,
    agentId: z.number().int().nonnegative(),
    event: z.object({ type: z.string().min(1) }).passthrough(),
  })
  .strict();
export type LoopEventLine = z.infer<typeof LoopEventLine>;

