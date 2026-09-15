import { readFileSync } from "node:fs";
import path from "node:path";
import { keccak256, toHex } from "viem";
import { ExperimentConfigV1 } from "@fleet/schemas";

export type DemoRequest = {
  agentCount: number;
  goal: string;
  constitution: "existing" | "custom";
  customConstitution?: string;
};

export const DEMO_DEFAULT_GOAL = "Implement the failing functions in this repository and test the result. When the work is ready, request fleet review of publishing src/index.js as the canonical task artifact. Explain any disagreement and vote independently on the exact publication.";
export const DEMO_MODEL = "meta/muse-spark-1.3-contributor";
const ROLES = ["planner", "engineer", "critic", "budget-reviewer", "safety-reviewer"];

export function parseDemoRequest(value: unknown): DemoRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected experiment settings.");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !["agentCount", "goal", "constitution", "customConstitution"].includes(key))) throw new Error("Unknown experiment setting.");
  if (!Number.isSafeInteger(data.agentCount) || Number(data.agentCount) < 2 || Number(data.agentCount) > 2000) throw new Error("Choose between 2 and 2,000 agents.");
  if (typeof data.goal !== "string" || data.goal.trim().length < 10 || data.goal.length > 4000) throw new Error("The goal must be between 10 and 4,000 characters.");
  if (data.constitution !== "existing" && data.constitution !== "custom") throw new Error("Choose an existing or custom constitution.");
  if (data.customConstitution !== undefined && typeof data.customConstitution !== "string") throw new Error("Custom constitution must be text.");
  if (data.constitution === "custom" && (typeof data.customConstitution !== "string" || data.customConstitution.trim().length < 20 || data.customConstitution.length > 24000)) throw new Error("A custom constitution must be between 20 and 24,000 characters.");
  return { agentCount: Number(data.agentCount), goal: data.goal.trim(), constitution: data.constitution,
    ...(data.constitution === "custom" ? { customConstitution: (data.customConstitution as string).trim() } : {}) };
}

/** Server-owned defaults. Browser input cannot supply RPCs, keys, paths or spending ceilings. */
export function createDemoConfig(request: unknown, options: {
  repoRoot: string; name: string; rpcHttp: string; rpcWs: string; agoraUrl: string;
}) {
  const settings = parseDemoRequest(request);
  const base = JSON.parse(readFileSync(path.join(options.repoRoot, "experiments/examples/local-artifact-publication-model.experiment.json"), "utf8"));
  const text = settings.constitution === "custom" ? settings.customConstitution! : readFileSync(path.join(options.repoRoot, "experiments/constitutions/fleet-v1.md"), "utf8");
  const constitutionHash = keccak256(toHex(text));
  base.name = options.name;
  base.target = { kind: "base-sepolia", rpcHttp: options.rpcHttp, rpcWs: options.rpcWs };
  base.fleet.tokenName = "FleetGov";
  base.fleet.tokenSymbol = "FLEET";
  base.fleet.members = Array.from({ length: settings.agentCount }, (_, id) => ({
    role: ROLES[id % ROLES.length], provider: "openrouter", model: DEMO_MODEL, promptVersion: "1", operatorLabel: "fleet-governance-gcp",
  }));
  base.inference.budget.providerCreditPoolUsd = 50;
  base.inference.budget.maxCostUsd = 1;
  base.inference.budget.maxTokens = Math.max(2_000_000, settings.agentCount * 100_000);
  base.inference.budget.reservedVoteTokens = settings.agentCount * 65_000;
  base.task.charter.budget.inferenceTokens = base.inference.budget.maxTokens;
  // Leave time for all independent model calls and transaction inclusion on the public testnet.
  base.governance.votingPeriod = 300;
  base.task.charterSource = "experiment";
  base.task.charter.goal = settings.goal;
  base.task.charter.notes += ` Selected constitution keccak256: ${constitutionHash}.`;
  base.task.constitution = { title: settings.constitution === "custom" ? "Custom experiment constitution" : "Fleet constitution v1", text,
    sources: settings.constitution === "custom" ? [] : ["https://www.anthropic.com/constitution", "https://model-spec.openai.com/2025-04-11.html"] };
  base.task.repoFixture = "experiments/fixtures/repos/tiny-lib";
  base.display.agoraNextBaseUrl = options.agoraUrl;
  return { settings, constitutionHash, config: ExperimentConfigV1.parse(base) };
}
