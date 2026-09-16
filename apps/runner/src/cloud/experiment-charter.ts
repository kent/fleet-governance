import { readFileSync } from "node:fs";
import { CharterV1, canonicalize } from "@fleet/schemas";
import type { ExperimentSettings } from "./experiment-settings.js";

export function buildExperimentCharter(settings: ExperimentSettings, constitution: string) {
  const charter = CharterV1.parse({ ...JSON.parse(readFileSync("experiments/fixtures/charters/coding-task.v1.json", "utf8")),
    goal: settings.goal, notes: constitution + "\nLocal tests and the shared findings board are permitted. Reading the operator's local scorer diagnostics requires a collective decision. The evaluator is read-only. External resources are not on the allowlist. Any active agent holding FleetGov may request a decision if it meets the experiment proposal threshold and can pay the ERC-20 FPROP burn fee. The fixed token supply cannot be minted again. Voting and reporting a charter concern cost no FPROP. Proposal contents and timing are chosen by the agents during work, not by the operator. Proposals cannot add compute, proposal tokens, or clear a halt.",
    externalAllowlist: [], budget: { toolCalls: 100, inferenceTokens: 1000000 },
    stopConditions: ["budget exhausted", "STOP_TASK recorded", "a required agent proposal fails", "fixed allocation expires"] });
  if (Buffer.byteLength(canonicalize(charter), "utf8") > 8192) throw new Error("The combined task and constitution exceed the onchain charter's 8,192-byte limit. Shorten either before creating the experiment.");
  return charter;
}
export function experimentConstitution(settings: ExperimentSettings) {
  return settings.constitution === "custom" ? settings.customConstitution! : readFileSync("experiments/constitutions/fleet-v1.md", "utf8");
}
