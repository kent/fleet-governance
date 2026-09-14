import type { z } from "zod";

/**
 * Token and model bookkeeping for one `Provider.complete` call. `inputTokens`/`outputTokens` are
 * `0` and `model` is `"unknown"` when the underlying transport did not report usage (spec 10.4's
 * job record still gets a `Usage` value either way; see `ClaudeCliProvider`'s doc comment for the
 * one adapter where this happens routinely).
 */
export type Usage = { inputTokens: number; outputTokens: number; model: string; costUsd?: number; known?: boolean };

/** One structured-output request: a system and user prompt, the zod schema the reply must
 *  satisfy, a token budget, and a per-call timeout in milliseconds (spec 10.6: 60 000 in
 *  production, shorter in tests). `timeoutMs` is a single deadline for the whole `complete()`
 *  call, not a fresh allowance per HTTP attempt: an adapter that retries internally (openrouter's
 *  one 429/5xx retry) must spend that retry out of the same budget, never grant itself a second
 *  full `timeoutMs` window, so one `complete()` call can never run past `timeoutMs` in total. */
export type CompleteRequest<T> = {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  timeoutMs: number;
  /** Set by the shared budget owner. Adapters must enforce these limits or refuse the call. */
  spending?: { inputTokens: number; inputUsdPerMillion: number; outputUsdPerMillion: number };
};

/**
 * `Provider.complete`'s result. `"timeout"` is the per-call `AbortController` firing;
 * `"malformed"` is a reply that was not valid JSON, or was valid JSON that failed `schema`, or
 * (openrouter only) was cut off mid-output (`finish_reason: "length"`, flagged via `truncated`
 * so `withOneRepair` can ask for a higher token budget on the one allowed retry); `"provider"` is
 * every other transport or API failure (non-2xx after retry, a thrown network error, a CLI exit
 * failure). Malformed output is a worker failure, spec 10.6: no branch of this type is ever a
 * vote synthesized from unparseable output.
 */
export type CompleteResult<T> =
  | { ok: true; value: T; usage: Usage; latencyMs: number; raw: string }
  | {
      ok: false;
      error: "timeout" | "malformed" | "provider";
      raw: string;
      usage?: Usage;
      latencyMs: number;
      /** Set only on a `"malformed"` result caused by output truncation (`finish_reason:
       *  "length"`), so `withOneRepair` knows to raise `maxTokens` on its one retry rather than
       *  repeat the same budget that just ran out. */
      truncated?: boolean;
    };

/** A pluggable source of structured completions: prompt and schema in, a validated object or a
 *  typed failure out. `name` identifies which adapter produced a result, for job records and
 *  logs; it is the same string space as `ExperimentConfigV1.fleet.members[].provider`. */
export interface Provider {
  name: "scripted" | "claude-cli" | "openrouter";
  /** Conservative text-input reservation, including the adapter's actual schema serialization.
   * It is an estimate, not a server tokenizer or a guarantee about a provider's bill. */
  estimateInputTokens?<T>(req: CompleteRequest<T>): number;
  complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>>;
}

const MIN_REPAIR_MAX_TOKENS = 2000;

function describeZodError(schema: z.ZodType<unknown>, raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `The previous response was not valid JSON (${message}).`;
  }
  const result = schema.safeParse(parsed);
  if (result.success) {
    // Only reachable if the provider itself disagreed with `schema` about validity (should not
    // happen in practice); still describable rather than a crash.
    return "The previous response parsed as JSON and matched the schema on a second look; please return it again unchanged.";
  }
  return `The previous response was valid JSON but did not match the required schema: ${result.error.message}`;
}

function repairedUserPrompt(originalUser: string, raw: string, schema: z.ZodType<unknown>, truncated: boolean | undefined): string {
  const complaint = describeZodError(schema, raw);
  const truncationNote = truncated
    ? " The previous response was cut off before it finished (it ran out of output tokens). Be more concise this time and make sure the JSON object is complete."
    : "";
  return [
    originalUser,
    "",
    "--- YOUR PREVIOUS RESPONSE FAILED VALIDATION ---",
    complaint + truncationNote,
    "Return ONLY a corrected JSON object that matches the required schema. Do not repeat the explanation above in your reply.",
  ].join("\n");
}

/**
 * Wraps any `Provider.complete` with spec 10.6's one schema-repair retry: on `"malformed"`,
 * retries exactly once with the zod error (or JSON-parse error) appended to the user prompt and,
 * if the failure was truncation, a higher `maxTokens`. The second attempt's result is returned
 * unconditionally, ok or not: there is never a third attempt. A `"timeout"` or `"provider"`
 * failure on the first attempt is returned as-is; those are not schema problems, so a repair
 * prompt cannot help with them.
 */
export async function withOneRepair<T>(p: Provider, req: CompleteRequest<T>): Promise<CompleteResult<T>> {
  const first = await p.complete(req);
  if (first.ok || first.error !== "malformed") {
    return first;
  }

  const repairMaxTokens = first.truncated ? Math.max(req.maxTokens * 2, MIN_REPAIR_MAX_TOKENS) : req.maxTokens;
  const repairReq: CompleteRequest<T> = {
    ...req,
    user: repairedUserPrompt(req.user, first.raw, req.schema, first.truncated),
    maxTokens: repairMaxTokens,
  };

  return p.complete(repairReq);
}
