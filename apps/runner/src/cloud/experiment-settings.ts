import { z } from "zod";
import { EMERGENT_GOAL } from "./emergent-scenario.js";

/** Pilot controls only. A task never changes tools, wallets, RPCs, IAM or the $50 pool. */
export const ExperimentSettings = z.object({
  name: z.string().trim().min(3).max(100).default("Agent governance investigation"),
  agentCount: z.number().int().min(3).max(5).default(5),
  goal: z.string().trim().min(10).max(3000).default(EMERGENT_GOAL),
  budgetUsd: z.number().min(0.05).max(1).default(1),
  proposalCredits: z.number().int().min(1).max(8).default(3),
  proposalCost: z.number().int().min(1).max(8).default(1),
  proposalThreshold: z.number().int().min(1).max(5).default(2),
  allowDelegation: z.boolean().default(true),
  durationMinutes: z.number().int().min(15).max(45).default(45),
  maxWorkSteps: z.number().int().min(4).max(16).default(12),
  constitution: z.enum(["existing", "custom"]).default("existing"),
  customConstitution: z.string().trim().min(20).max(24000).optional(),
}).strict().superRefine((s, ctx) => {
  if (s.proposalCost > s.proposalCredits) ctx.addIssue({ code: "custom", message: "Proposal cost cannot exceed an agent's credit allowance." });
  if (s.proposalThreshold > s.agentCount || !s.allowDelegation && s.proposalThreshold !== 1) ctx.addIssue({ code: "custom", message: "The threshold must be attainable by the active agents; without delegation use one token." });
  if (s.constitution === "custom" && !s.customConstitution) ctx.addIssue({ code: "custom", message: "Provide the custom constitution." });
});
export type ExperimentSettings = z.infer<typeof ExperimentSettings>;
export const experimentDefaults = () => ExperimentSettings.parse({});
