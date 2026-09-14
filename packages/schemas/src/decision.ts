import { z } from "zod";
import { ActionClass, CharterV1 } from "./charter.js";
import { DecimalString, Hex32 } from "./primitives.js";

export const DecisionKind = z.enum([
  "CHOOSE_PATH",
  "GRANT_EXCEPTION",
  "AMEND_CHARTER",
  "STOP_TASK",
  "ESCALATE_TO_HUMAN",
]);
export type DecisionKind = z.infer<typeof DecisionKind>;

/** The on-chain uint8 encoding of each DecisionKind, in ledger enum order. */
export const decisionKindToUint8: Record<DecisionKind, 0 | 1 | 2 | 3 | 4> = {
  CHOOSE_PATH: 0,
  GRANT_EXCEPTION: 1,
  AMEND_CHARTER: 2,
  STOP_TASK: 3,
  ESCALATE_TO_HUMAN: 4,
};

export const ActionDescriptor = z
  .object({
    class: ActionClass,
    target: z.string(),
    argsHash: Hex32,
  })
  .strict();
export type ActionDescriptor = z.infer<typeof ActionDescriptor>;

export const DecisionV1 = z
  .object({
    schema: z.literal("fleet.decision.v1"),
    taskId: DecimalString,
    kind: DecisionKind,
    expectedVersion: z.number().int().positive(),
    payloadHash: Hex32,
    proposerAgentId: z.number().int().nonnegative(),
    action: ActionDescriptor.optional(),
    newCharter: CharterV1.optional(),
    summary: z.string().min(1).max(1024),
    rationale: z.string().min(1),
    assumptions: z.array(z.string()),
    riskFlags: z.array(z.string()),
  })
  .strict();
export type DecisionV1 = z.infer<typeof DecisionV1>;
