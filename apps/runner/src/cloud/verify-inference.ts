import { z } from "zod";
import { InferenceScheduler, OpenRouterProvider, assertOpenRouterBudgetKey } from "@fleet/agent-runtime";
import { InferenceBudget } from "@fleet/schemas";
import { DEMO_MODEL } from "../lib/demo-config.js";

// Opt-in CI check only. It cannot access a wallet, deploy contracts or launch an experiment.
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("The experiment inference credential is missing.");
await assertOpenRouterBudgetKey(key, 0.02, fetch, 50);
const scheduler = new InferenceScheduler({ concurrency: 1, reservedVoteSlots: 0, maxCalls: 1, reservedVoteCalls: 0,
  budget: InferenceBudget.parse({ maxTokens: 65_536, maxCostUsd: 0.02, reservedVoteTokens: 0, reservedVoteCostUsd: 0,
    prices: { [DEMO_MODEL]: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } } }), journal: () => {} });
try {
  const provider = scheduler.wrap(new OpenRouterProvider({ apiKey: key, model: DEMO_MODEL, maxAttempts: 1 }), { agentId: 0, model: DEMO_MODEL, purpose: "task" });
  const result = await provider.complete({ system: "This is a deployment connectivity check. Return the requested JSON only.",
    user: "Set connected to true and describe this connectivity check in one short sentence.",
    schema: z.object({ connected: z.literal(true), message: z.string().min(1).max(120) }).strict(), maxTokens: 2000, timeoutMs: 60_000 });
  const summary = scheduler.summary();
  if (!result.ok || summary.budget?.reservationBreached || summary.unknownUsageCalls || summary.unknownCostCalls) throw new Error("Bounded inference check did not pass.");
  console.log("Live Muse Spark inference verified:", JSON.stringify({ calls: summary.callsStarted, tokens: summary.inputTokens + summary.outputTokens,
    costUsd: summary.reportedCostUsd, reservationBreached: summary.budget?.reservationBreached, creditPoolLimitUsd: 50 }));
} finally { await scheduler.close(); }
