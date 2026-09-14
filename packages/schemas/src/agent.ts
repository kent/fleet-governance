import { z } from "zod";
import { ActionClass } from "./charter.js";

/**
 * The arguments one tool call carries. Every field is optional: which ones matter depends on the
 * action class (`content` for `write_repo`, `path` and `scheme` for `network_fetch`, `pkg` for
 * `package_install`; `read_repo` and `run_tests` need none), and the sandbox's `ToolRouter` reads
 * exactly these four and nothing else.
 *
 * Naming them, rather than declaring a free-form `z.record(z.unknown())`, is what makes the shape
 * usable under a strict structured-output mode: `zod-to-json-schema` renders a record as
 * `{ type: "object", additionalProperties: {} }`, and the OpenRouter adapter's
 * `forceNoAdditionalPropertiesEverywhere` then rewrites that to `additionalProperties: false`,
 * which would leave a model unable to emit any argument at all (a `write_repo` step would arrive
 * with an empty `args` and silently write an empty file). Naming the four fields gives a
 * strict-mode provider a property list it can actually fill in.
 *
 * `.passthrough()` rather than `.strict()`: a provider that does not enforce a JSON schema (the
 * Claude CLI adapter) may return an argument this schema does not name, and dropping the call for
 * that would be worse than carrying the extra key through to a router that ignores it. The type
 * stays assignable to the sandbox's `ToolCall["args"]` (`Record<string, unknown>`) either way.
 */
export const AgentToolArgs = z
  .object({
    /** `write_repo`: the file's new contents. */
    content: z.string().nullable().optional(),
    /** `network_fetch`: the request path, forced to start with "/" by the router. */
    path: z.string().nullable().optional(),
    /** `network_fetch`: the URL scheme; anything but "http" is treated as "https". */
    scheme: z.enum(["http", "https"]).nullable().optional(),
    /** `package_install`: the package specifier, validated against npm's grammar by the router. */
    pkg: z.string().nullable().optional(),
  })
  .passthrough();
export type AgentToolArgs = z.infer<typeof AgentToolArgs>;

/** One tool call a model asked for: the same shape as the sandbox's `ToolCall`, as a schema a
 *  provider's structured output can be validated against. */
export const AgentToolCall = z
  .object({
    class: ActionClass,
    target: z.string(),
    args: AgentToolArgs,
  })
  .strict();
export type AgentToolCall = z.infer<typeof AgentToolCall>;

/**
 * `fleet.step.v1`: the coordinator's next step, one tool call plus the reason for it. Published to
 * the shared step board (spec 10.3) before it executes, so every other member sees the same step
 * and can object to it.
 */
export const StepV1 = z
  .object({
    tool: AgentToolCall,
    why: z.string().min(1),
  })
  .strict();
export type StepV1 = z.infer<typeof StepV1>;

/**
 * `fleet.objection.v1`: one member's answer to the coordinator's published step. `alternative` is
 * both optional and nullable: optional because a member that does not object has nothing to name,
 * nullable because a strict structured-output mode requires every property to be present and
 * expresses "unset" as an explicit `null` (see `OpenRouterProvider`'s schema conversion).
 *
 * An objection only becomes a `CHOOSE_PATH` proposal when `objects` is true *and* an
 * `alternative` is named: a deterministic decision needs a concrete path to choose, and a hash of
 * one to put on chain.
 */
export const ObjectionV1 = z
  .object({
    objects: z.boolean(),
    alternative: AgentToolCall.nullable().optional(),
    why: z.string().min(1),
  })
  .strict();
export type ObjectionV1 = z.infer<typeof ObjectionV1>;

/**
 * `fleet.blockresponse.v1`: what a member does about a gateway block (spec 10.3). `"propose"`
 * adopts the gateway's draft proposal, `"drop"` abandons the blocked action, `"escalate"` asks a
 * human. There is no fourth choice, and in particular no "retry": the retry rule is code's, not
 * the model's.
 */
export const BlockResponseV1 = z
  .object({
    choice: z.enum(["propose", "drop", "escalate"]),
    rationale: z.string().min(1),
  })
  .strict();
export type BlockResponseV1 = z.infer<typeof BlockResponseV1>;

/**
 * The ballot a model is asked for, and the only part of a vote a model ever chooses. `VoteV1`'s
 * two identity fields (`schema` and `proposalId`) are deliberately absent: `ModelPolicy` fills
 * them in from the proposal the worker anchored its read to, so a model cannot vote on a proposal
 * other than the one it was shown, and cannot mislabel the schema of its own output.
 *
 * `.strict()`, so a model that emits `proposalId` anyway does not have its value quietly kept
 * next to an assembled one: the parse fails, the policy reports `malformed`, and spec 10.6's rule
 * applies (a missing vote, never a synthesized one). `confidenceBps` is nullable as well as
 * optional because a strict structured-output mode requires every declared property to be present
 * and expresses "unset" as an explicit `null` (see `OpenRouterProvider`'s schema conversion);
 * `ModelPolicy` drops it when it arrives as `null`.
 */
export const ModelVoteV1 = z
  .object({
    support: z.enum(["FOR", "AGAINST", "ABSTAIN"]),
    rationale: z.string().min(1),
    assumptions: z.array(z.string()),
    riskFlags: z.array(z.string()),
    confidenceBps: z.number().int().min(0).max(10000).nullable().optional(),
  })
  .strict();
export type ModelVoteV1 = z.infer<typeof ModelVoteV1>;
