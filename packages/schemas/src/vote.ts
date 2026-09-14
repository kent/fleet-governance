import { z } from "zod";
import { DecimalString } from "./primitives.js";

export const VoteV1 = z
  .object({
    schema: z.literal("fleet.vote.v1"),
    proposalId: DecimalString,
    support: z.enum(["FOR", "AGAINST", "ABSTAIN"]),
    rationale: z.string().min(1),
    assumptions: z.array(z.string()),
    riskFlags: z.array(z.string()),
    confidenceBps: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type VoteV1 = z.infer<typeof VoteV1>;
