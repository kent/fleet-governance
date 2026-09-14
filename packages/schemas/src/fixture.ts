import { z } from "zod";
import { ActionClass, CharterV1 } from "./charter.js";
import { DecisionKind } from "./decision.js";
import { Host } from "./primitives.js";

/** Spec 15.3 / task 8's scripted agent vocabulary, shared with `@fleet/agent-runtime`'s
 *  `ScriptedDirective` (that package cannot depend on this one, so the string union is repeated
 *  here rather than imported; the two are kept in sync by hand). */
export const ScriptedDirective = z.enum(["FOR", "AGAINST", "ABSTAIN", "ABSENT", "MALFORMED", "LATE"]);
export type ScriptedDirective = z.infer<typeof ScriptedDirective>;

/**
 * The raw tool call a fixture's trigger describes, before it becomes an `ActionDescriptor`.
 * `args` is opaque data the runner canonicalizes and hashes (`@fleet/gateway`'s `describeAction`,
 * `@fleet/sdk`'s `payloadHashForAction`), never interpreted, matching how the gateway itself
 * treats a tool call's arguments.
 */
export const FixtureAction = z
  .object({
    class: ActionClass,
    target: z.string(),
    args: z.unknown(),
  })
  .strict();
export type FixtureAction = z.infer<typeof FixtureAction>;

/**
 * What causes this fixture's one proposal: which agent proposes, what kind of decision, and the
 * payload for that kind (`action` for `GRANT_EXCEPTION`/`CHOOSE_PATH`, `newCharter` for
 * `AMEND_CHARTER`). `STOP_TASK` and `ESCALATE_TO_HUMAN` need neither.
 */
export const FixtureTrigger = z
  .object({
    agentId: z.number().int().nonnegative(),
    kind: DecisionKind,
    action: FixtureAction.optional(),
    newCharter: CharterV1.optional(),
    summary: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.kind === "GRANT_EXCEPTION" || value.kind === "CHOOSE_PATH") && !value.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `trigger.kind ${value.kind} requires trigger.action`,
        path: ["action"],
      });
    }
    if (value.kind === "AMEND_CHARTER" && !value.newCharter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "trigger.kind AMEND_CHARTER requires trigger.newCharter",
        path: ["newCharter"],
      });
    }
  });
export type FixtureTrigger = z.infer<typeof FixtureTrigger>;

export const FixtureDelegateStep = z
  .object({
    kind: z.literal("delegate"),
    agentId: z.number().int().nonnegative(),
    toAgentId: z.number().int().nonnegative(),
  })
  .strict();
export type FixtureDelegateStep = z.infer<typeof FixtureDelegateStep>;

export const FixtureImpostorStep = z.object({ kind: z.literal("impostorAttempt") }).strict();
export type FixtureImpostorStep = z.infer<typeof FixtureImpostorStep>;

export const FixturePreStep = z.discriminatedUnion("kind", [FixtureDelegateStep, FixtureImpostorStep]);
export type FixturePreStep = z.infer<typeof FixturePreStep>;

const AGENT_ID_KEY_PATTERN = /^(0|[1-9][0-9]*)$/;

/** Agent id (decimal string key, since JSON object keys are always strings) to scripted vote
 *  directive. Not every agent id needs an entry: an agent with no entry is treated the same as
 *  an explicit `"ABSENT"` (see `ScriptedPolicy.evaluateProposal`). */
export const FixtureScript = z.record(
  z.string().regex(AGENT_ID_KEY_PATTERN, "script keys must be non-negative decimal agent ids"),
  ScriptedDirective,
);
export type FixtureScript = z.infer<typeof FixtureScript>;

export const FixtureGuardianStep = z.object({ pauseAndCancelAfterQueue: z.boolean() }).strict();
export type FixtureGuardianStep = z.infer<typeof FixtureGuardianStep>;

/** The subset of `ProposalState` names (`@fleet/sdk`) a fixture's `expected.outcome` can name. */
export const FixtureExpectedOutcome = z.enum([
  "Pending",
  "Active",
  "Canceled",
  "Defeated",
  "Succeeded",
  "Queued",
  "Expired",
  "Executed",
]);
export type FixtureExpectedOutcome = z.infer<typeof FixtureExpectedOutcome>;

export const FixtureExpected = z
  .object({
    outcome: FixtureExpectedOutcome,
    decisionCount: z.number().int().nonnegative(),
    charterVersion: z.number().int().positive().optional(),
    gatewayAfter: z.enum(["ALLOW", "BLOCK"]).optional(),
    missingVotes: z.number().int().nonnegative().optional(),
    revertedAttempts: z.number().int().nonnegative().optional(),
  })
  .strict();
export type FixtureExpected = z.infer<typeof FixtureExpected>;

/**
 * `fleet.fixture.v1`: one of the eight scripted divergence scenarios under
 * `experiments/fixtures/scripted/` (task 8 brief and controller notes, spec 15.3). The Runner
 * submits `trigger` as a proposal from `trigger.agentId`'s key, runs `preSteps` first, drives
 * `script` as votes, applies `guardian` after queueing when present, and asserts `expected`
 * against the resulting chain state.
 */
export const FixtureV1 = z
  .object({
    schema: z.literal("fleet.fixture.v1"),
    name: z.string().min(1),
    description: z.string().min(1),
    trigger: FixtureTrigger,
    preSteps: z.array(FixturePreStep).optional(),
    script: FixtureScript,
    guardian: FixtureGuardianStep.optional(),
    expected: FixtureExpected,
  })
  .strict();
export type FixtureV1 = z.infer<typeof FixtureV1>;

/** One fake host a model fixture starts before the run: `name` is the charter-level hostname the
 *  gateway evaluates (for example `examples.internal`), `port` is the loopback port the Runner
 *  (task 7) binds it to, and `site` names a directory under
 *  `experiments/fixtures/hosts/examples-internal/sites/` whose files the host serves. */
export const ModelFixtureHost = z
  .object({
    name: Host,
    port: z.number().int().min(1).max(65535),
    site: z.string().min(1),
  })
  .strict();
export type ModelFixtureHost = z.infer<typeof ModelFixtureHost>;

/** What a model-driven fixture asserts once the fleet stops, run by a human or a rubric-following
 *  report rather than by exact-match chain state (`decisionCount` and friends do not apply: the
 *  model decides how many proposals to make, if any). */
export const ModelFixtureExpected = z
  .object({
    outcome: z.enum(["Defeated", "Executed", "any"]),
    gatewayAfter: z.enum(["ALLOW", "BLOCK"]).optional(),
    minProposals: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModelFixtureExpected = z.infer<typeof ModelFixtureExpected>;

/**
 * `fleet.fixture.model.v1`: a model-driven scenario under `experiments/fixtures/model/` (task 4
 * brief and controller notes). Unlike `FixtureV1`, no `trigger` scripts a single proposal and no
 * `script` scripts votes: the fleet reads `charter` and the task repository at `repoFixture` (with
 * `repoOverlay`, if present, copied over it afterward) and decides everything itself, for up to
 * `maxSteps` steps, against whichever hosts in `hosts` the Runner starts. `expected` and `rubric`
 * are read by a human, or by a report writer, after the run, not asserted automatically against
 * exact chain state the way `FixtureV1.expected` is.
 */
export const ModelFixtureV1 = z
  .object({
    schema: z.literal("fleet.fixture.model.v1"),
    name: z.string().min(1),
    description: z.string().min(1),
    agentsScripted: z.literal(false),
    trigger: z.null(),
    charter: z.string().min(1),
    repoFixture: z.string().min(1),
    repoOverlay: z.string().min(1).optional(),
    hosts: z.array(ModelFixtureHost),
    coordinatorRole: z.string().min(1).default("planner"),
    maxSteps: z.number().int().positive(),
    expected: ModelFixtureExpected,
    rubric: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ModelFixtureV1 = z.infer<typeof ModelFixtureV1>;

/** Either fixture shape a file under `experiments/fixtures/` can hold, discriminated on
 *  `schema` so a bad or mistyped literal fails parsing with a clear message instead of silently
 *  matching the wrong branch. */
export const FixtureAnyV1 = z.discriminatedUnion("schema", [FixtureV1, ModelFixtureV1]);
export type FixtureAnyV1 = z.infer<typeof FixtureAnyV1>;

/** Parses a fixture file of either shape, keyed by its `schema` field. */
export function parseFixtureFile(json: unknown): FixtureAnyV1 {
  return FixtureAnyV1.parse(json);
}
