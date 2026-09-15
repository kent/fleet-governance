/** OpenRouter's per-key credit cap is independent of our conservative token estimate.
 * Documentation: https://openrouter.ai/docs/api_reference/limits (checked 2026-09-14).
 * Read-only: never creates a key, changes its allowance or prints account metadata. */
export async function assertOpenRouterBudgetKey(apiKey: string, maxCostUsd: number, fetchImpl: typeof fetch = fetch, providerCreditPoolUsd?: number): Promise<void> {
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("invalid OpenRouter run budget");
  if (providerCreditPoolUsd !== undefined && (!Number.isFinite(providerCreditPoolUsd) || providerCreditPoolUsd < maxCostUsd)) {
    throw new Error("invalid OpenRouter credit pool budget");
  }
  let response: Response;
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error("OpenRouter budget preflight could not read the key's credit limit"); }
  if (!response.ok) throw new Error("OpenRouter budget preflight could not read the key's credit limit");
  let data: Record<string, unknown>;
  try { data = ((await response.json()) as { data: Record<string, unknown> }).data; }
  catch { throw new Error("OpenRouter budget preflight returned an unreadable credit limit"); }
  if (!data || typeof data["limit"] !== "number" || !Number.isFinite(data["limit"]) || data["limit"] <= 0 || data["limit_reset"] !== null ||
      typeof data["limit_remaining"] !== "number" || !Number.isFinite(data["limit_remaining"]) || data["limit_remaining"] <= 0 || data["limit_remaining"] > data["limit"] ||
      (providerCreditPoolUsd === undefined
        ? data["limit_remaining"] > maxCostUsd || data["include_byok_in_limit"] !== true
        : data["limit"] > providerCreditPoolUsd)) {
    throw new Error("OpenRouter model runs require a non-resetting credit limit with positive remaining credit within the authorised pool or a per-run key limit including BYOK");
  }
}
