import { expect, it } from "vitest";
import { buildExperimentCharter } from "./experiment-charter.js";
import { BondExperimentSettings, ExperimentSettings } from "./experiment-settings.js";
it("keeps model spend within the operator pool and proposal supply finite", () => {
  expect(ExperimentSettings.parse({})).toMatchObject({ agentCount: 5, budgetUsd: 1, proposalCredits: 3, proposalCost: 1, proposalThreshold: 1, allowDelegation: true });
  for (const input of [{ budgetUsd: 1.01 }, { budgetUsd: 0 }, { proposalCredits: 9 }, { proposalCredits: 2, proposalCost: 3 }, { proposalCost: 0 }, { agentCount: 6 }, { durationMinutes: 46 }, { rpcUrl: "https://override.invalid" }]) expect(ExperimentSettings.safeParse(input).success).toBe(false);
});
it("requires an attainable threshold and preserves the selected task and constitution", () => {
  expect(ExperimentSettings.safeParse({ allowDelegation: false, proposalThreshold: 2 }).success).toBe(false);
  expect(ExperimentSettings.parse({ allowDelegation: false, proposalThreshold: 1 }).allowDelegation).toBe(false);
  expect(ExperimentSettings.safeParse({ agentCount: 3, proposalThreshold: 4 }).success).toBe(false);
  expect(ExperimentSettings.safeParse({ constitution: "custom" }).success).toBe(false);
  expect(ExperimentSettings.parse({ goal: "Investigate the scorer discrepancy", constitution: "custom", customConstitution: "Respect scope and preserve public evidence." })).toMatchObject({ goal: "Investigate the scorer discrepancy", customConstitution: "Respect scope and preserve public evidence." });
});


it("checks the actual UTF-8 charter size before allocating resources", () => {
  const settings = ExperimentSettings.parse({});
  expect(buildExperimentCharter(settings, "Respect scope and stop when required.").goal).toBe(settings.goal);
  expect(() => buildExperimentCharter(settings, "🧪".repeat(2200))).toThrow("8,192-byte");
});

it("exposes only one-token bond controls for new experiments", () => {
  expect(BondExperimentSettings.parse({})).toMatchObject({ proposalBond: 0.1, proposalCooldownSeconds: 60, bondParticipationPercent: 60 });
  for (const input of [{ proposalBond: 0 }, { proposalBond: 1.01 }, { proposalBond: 0.015 }, { proposalCooldownSeconds: 29 }, { proposalCooldownSeconds: 601 }, { bondParticipationPercent: 9 }, { bondParticipationPercent: 101 }, { proposalCredits: 3 }]) expect(BondExperimentSettings.safeParse(input).success).toBe(false);
});
