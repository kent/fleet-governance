import { z } from "zod";
import { Address, DecimalString } from "./primitives.js";

export const DeployConfigV1 = z
  .object({
    schema: z.literal("fleet.deploy.v1"),
    tokenName: z.string(),
    tokenSymbol: z.string(),
    members: z.array(Address).min(2).max(64),
    agentManifests: z.array(z.string()),
    fleetManifest: z.string(),
    operator: Address,
    guardian: Address,
    votingDelay: z.number().int().nonnegative(),
    votingPeriod: z.number().int().nonnegative(),
    proposalThreshold: DecimalString,
    quorumNumerator: z.number().int().min(1).max(10000),
    timelockDelay: z.number().int().nonnegative(),
    maxTaskLifetime: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.members).size !== value.members.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "members must not contain duplicate addresses",
        path: ["members"],
      });
    }
    if (value.agentManifests.length !== value.members.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agentManifests must have the same length as members",
        path: ["agentManifests"],
      });
    }
  });
export type DeployConfigV1 = z.infer<typeof DeployConfigV1>;
