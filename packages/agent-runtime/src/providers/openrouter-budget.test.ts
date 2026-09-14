import { expect, it, vi } from "vitest";
import { assertOpenRouterBudgetKey } from "./openrouter-budget.js";

const valid = { limit: 10, limit_reset: null, limit_remaining: 1, include_byok_in_limit: true };
const fakeFetch = (data: unknown) => vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch;

it("accepts a provider credit ceiling within the run budget without mutating the key", async () => {
  const fetcher = fakeFetch(valid);
  await expect(assertOpenRouterBudgetKey("test-only-key", 1, fetcher)).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/v1/key", expect.objectContaining({ headers: { Authorization: "Bearer test-only-key" } }));
  const init = vi.mocked(fetcher).mock.calls[0]?.[1];
  expect(init?.method).toBeUndefined();
  expect(init?.body).toBeUndefined();
});

it.each([{ limit: null }, { limit_remaining: null }, { limit_remaining: 1.01 }, { limit_remaining: 0 }, { limit_reset: "daily" }, { include_byok_in_limit: false }])("refuses an unsuitable provider cap: %j", async override => {
  await expect(assertOpenRouterBudgetKey("test-only-key", 1, fakeFetch({ ...valid, ...override }))).rejects.toThrow("non-resetting credit limit");
});

it("fails closed on an unreadable cap and never echoes the response or key", async () => {
  const fetcher = vi.fn(async () => new Response("private account detail", { status: 401 })) as unknown as typeof fetch;
  await expect(assertOpenRouterBudgetKey("test-only-key", 1, fetcher)).rejects.toThrow("could not read");
  await expect(assertOpenRouterBudgetKey("test-only-key", 1, fakeFetch(undefined))).rejects.toThrow("non-resetting");
});
