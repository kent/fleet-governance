import { z } from "zod";
import { CharterV1 } from "./charter.js";
import { DecimalString } from "./primitives.js";

export const ExperimentConfigV1 = z
  .object({
    schema: z.literal("fleet.experiment.v1"),
    name: z.string(),
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
                provider: z.enum(["scripted", "claude-cli", "anthropic-api"]),
                model: z.string(),
                promptVersion: z.string(),
                operatorLabel: z.string(),
              })
              .strict(),
          )
          .min(2)
          .max(64),
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
