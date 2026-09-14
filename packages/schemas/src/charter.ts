import { z } from "zod";
import { Host } from "./primitives.js";

export const ActionClass = z.enum([
  "read_repo",
  "write_repo",
  "run_tests",
  "package_install",
  "network_fetch",
  "shell",
]);
export type ActionClass = z.infer<typeof ActionClass>;

export const CharterV1 = z
  .object({
    schema: z.literal("fleet.charter.v1"),
    goal: z.string().min(1),
    allowedActionClasses: z.array(ActionClass),
    forbiddenActions: z.array(z.string()),
    externalAllowlist: z.array(Host),
    budget: z
      .object({
        toolCalls: z.number().int().positive(),
        inferenceTokens: z.number().int().positive(),
      })
      .strict(),
    stopConditions: z.array(z.string()),
    notes: z.string().optional(),
  })
  .strict();
export type CharterV1 = z.infer<typeof CharterV1>;
