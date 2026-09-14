import { MAX_FLEET_MEMBERS } from "./limits.js";
import { z } from "zod";
import { CharterV1 } from "./charter.js";
import { DecimalString } from "./primitives.js";

const Usd = z.number().finite().nonnegative().max(1_000_000);
export const InferenceBudget = z.object({
  maxTokens: z.number().int().positive().safe(),
  maxCostUsd: Usd.min(0.000000001),
  reservedVoteTokens: z.number().int().nonnegative().safe().optional(),
  reservedVoteCostUsd: Usd.optional(),
  maxInputTokensPerCall: z.number().int().positive().max(2_000_000).default(65_536),
  maxOutputTokensPerCall: z.number().int().positive().max(128_000).default(4000),
  prices: z.record(z.object({ inputUsdPerMillion: Usd, outputUsdPerMillion: Usd }).strict()),
}).strict()
  .refine(value => value.reservedVoteTokens === undefined || value.reservedVoteTokens < value.maxTokens, "reserved voting tokens must be below the token limit")
  .refine(value => value.reservedVoteCostUsd === undefined || value.reservedVoteCostUsd < value.maxCostUsd, "reserved voting dollars must be below the dollar limit");
export type InferenceBudget = z.infer<typeof InferenceBudget>;

export const InferenceLimits = z.object({
  concurrency: z.number().int().min(1).max(256).default(8),
  reservedVoteSlots: z.number().int().min(0).default(1),
  maxCalls: z.number().int().min(1).max(1_000_000).default(10_000),
  reservedVoteCalls: z.number().int().min(0).optional(),
  requestTimeoutMs: z.number().int().min(1000).max(3_600_000).default(60_000),
  budget: InferenceBudget.optional(),
}).strict().refine(value => value.reservedVoteSlots < value.concurrency, "reserved voting slots must be below concurrency")
  .refine(value => value.reservedVoteCalls === undefined || value.reservedVoteCalls < value.maxCalls, "reserved voting calls must be below the call limit");
export type InferenceLimits = z.infer<typeof InferenceLimits>;

export const RuntimeLimits = z.object({
  toolConcurrency: z.number().int().min(1).max(128).default(4),
  voteConcurrency: z.number().int().min(1).max(256).default(32),
}).strict();
export type RuntimeLimits = z.infer<typeof RuntimeLimits>;

export const ExperimentConfigV1 = z
  .object({
    schema: z.literal("fleet.experiment.v1"),
    name: z.string(),
    inference: InferenceLimits.optional(),
    runtime: RuntimeLimits.optional(),
    target: z
      .object({
        kind: z.enum(["local-anvil", "base-sepolia"]),
        rpcHttp: z.string().url(),
        rpcWs: z.string().url(),
      })
      .strict(),
    fleet: z
      .object({
        members: z
          .array(
            z
              .object({
                role: z.string(),
                provider: z.enum(["scripted", "claude-cli", "openrouter"]),
                model: z.string(),
                promptVersion: z.string(),
                operatorLabel: z.string(),
              })
              .strict(),
          )
          .min(2)
          .max(MAX_FLEET_MEMBERS),
        tokenName: z.string(),
        tokenSymbol: z.string(),
      })
      .strict(),
    governance: z
      .object({
        votingDelay: z.number().int(),
        votingPeriod: z.number().int(),
        timelockDelay: z.number().int(),
        quorumNumerator: z.number().int().min(1).max(10000),
        proposalThreshold: DecimalString,
        maxTaskLifetime: z.number().int(),
      })
      .strict(),
    task: z
      .object({
        charter: CharterV1,
        lifetime: z.number().int(),
        repoFixture: z.string(),
      })
      .strict(),
    scenario: z
      .object({
        fixture: z.string(),
        agentsScripted: z.boolean(),
      })
      .strict(),
    capture: z
      .object({
        gcsBucket: z.string().optional(),
        reportDir: z.string(),
      })
      .strict(),
    display: z
      .object({
        agoraNextBaseUrl: z.string().url().optional(),
      })
      .strict(),
  })
  .strict();
export type ExperimentConfigV1 = z.infer<typeof ExperimentConfigV1>;
