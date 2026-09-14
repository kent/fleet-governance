import { expect, it } from "vitest";
import { InferenceLimits } from "@fleet/schemas";
import { assertModelInferenceBudget } from "./model-runner.js";

const member = { role: "engineer", provider: "openrouter" as const, model: "test-model", promptVersion: "1" };
const limits = InferenceLimits.parse({ budget: { maxTokens: 1000, maxCostUsd: 1,
  prices: { "test-model": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
} });

it("requires explicit live spending and model-price limits before run setup", () => {
  expect(() => assertModelInferenceBudget([member], undefined)).toThrow("explicit inference.budget");
  expect(() => assertModelInferenceBudget([{ ...member, model: "unpriced" }], limits)).toThrow("prices is missing");
  expect(() => assertModelInferenceBudget([member], limits)).not.toThrow();
});

it("refuses live CLI inference whose adapter cannot enforce the reserved output and price", () => {
  expect(() => assertModelInferenceBudget([{ ...member, provider: "claude-cli" }], limits)).toThrow("cannot enforce");
});

it("keeps scripted verification independent of paid model credentials", () => {
  expect(() => assertModelInferenceBudget([{ ...member, provider: "scripted" }], undefined)).not.toThrow();
  expect(() => assertModelInferenceBudget([member], undefined, true)).not.toThrow();
});
