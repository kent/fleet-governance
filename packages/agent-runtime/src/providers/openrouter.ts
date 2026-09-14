import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CompleteRequest, CompleteResult, Provider, Usage } from "./types.js";

/** OpenRouter's default chat completions endpoint (controller notes, verified live 2026-09-14). */
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Owner's chosen default agent model on OpenRouter (progress ledger, 2026-09-14): low cost,
 *  1M context, supports `response_format`/`structured_outputs`/`tools`/`tool_choice`. Callers
 *  select a different model per agent via `opts.model` (`ExperimentConfigV1.fleet.members[].model`
 *  in production); Claude models on OpenRouter (`anthropic/claude-sonnet-5` and siblings) remain
 *  selectable the same way. */
export const DEFAULT_OPENROUTER_MODEL = "meta/muse-spark-1.3-contributor";

/** Recommended `CompleteRequest.maxTokens` for vote (`fleet.vote.v1`) and step (`fleet.step.v1`)
 *  outputs (controller notes: `meta/muse-spark-1.3-contributor` spends tokens on reasoning before
 *  the structured JSON, and 300 was verified to truncate mid-string). Callers are free to pass a
 *  different value; `withOneRepair` raises it further on a truncated first attempt. */
export const DEFAULT_VOTE_OR_STEP_MAX_TOKENS = 2000;

const HTTP_REFERER = "fleet-governance";
const X_TITLE = "fleet-governance";

type OpenRouterChoice = {
  message?: { content?: string | null };
  finish_reason?: string;
};

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  total_tokens?: number;
};

type OpenRouterResponseBody = {
  id?: string;
  model?: string;
  choices?: OpenRouterChoice[];
  usage?: OpenRouterUsage;
};

export type OpenRouterProviderOpts = {
  /** Never logged, never placed in an error message, a test fixture, a report, or a commit
   *  (controller notes). Only the `Authorization` header's value; the request body and every
   *  returned `raw`/error string are built from the prompt and the response body only. */
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Delay before the one retry on HTTP 429 or 5xx. Defaults to 300 ms; tests override this to
   *  keep the 429-then-success case fast. */
  retryBackoffMs?: number;
  /** Optional instrumentation hook, called with the full decoded response body (never the
   *  request, so the API key is never reachable from it) on every 2xx response. Used by the
   *  gated live smoke test to record latency, usage, and cost without a second live call; not
   *  otherwise part of the `Provider` contract. */
  onResponseBody?: (body: OpenRouterResponseBody) => void;
  /** Injectable clock for tests (fix round 1, F3): defaults to `Date.now`. `complete()`'s retry
   *  budget is computed from this, so a test can move time forward between a 429 response and
   *  the retry decision without waiting in real time or fighting `AbortSignal.timeout`'s own
   *  native timer. Not meant to be set in production. */
  now?: () => number;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type JsonSchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenRouter's `strict: true` structured-output mode requires `additionalProperties: false` on
 *  every object level of the schema (controller notes), not only the top one. `zodToJsonSchema`
 *  already emits that for every `.strict()` zod object (verified), but this walks the generated
 *  tree and forces it everywhere regardless, so a schema that forgets `.strict()` at some nested
 *  level still passes OpenRouter's validation instead of silently failing structured output. */
function forceNoAdditionalPropertiesEverywhere(node: unknown): void {
  if (!isPlainObject(node)) return;

  if (node.type === "object" || isPlainObject(node.properties)) {
    node.additionalProperties = false;
  }
  if (isPlainObject(node.properties)) {
    for (const value of Object.values(node.properties)) {
      forceNoAdditionalPropertiesEverywhere(value);
    }
  }
  if (Array.isArray(node.items)) {
    for (const item of node.items) forceNoAdditionalPropertiesEverywhere(item);
  } else if (node.items !== undefined) {
    forceNoAdditionalPropertiesEverywhere(node.items);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const b of branch) forceNoAdditionalPropertiesEverywhere(b);
    }
  }
  for (const key of ["definitions", "$defs"]) {
    const defs = node[key];
    if (isPlainObject(defs)) {
      for (const value of Object.values(defs)) forceNoAdditionalPropertiesEverywhere(value);
    }
  }
}

/** Widens one property schema node to also accept `null`, in place: an array `type` gets `"null"`
 *  appended if absent, a string `type` becomes a two-element array, and anything without a `type`
 *  key (a bare `$ref`, for instance) is wrapped in `anyOf` with a `{ type: "null" }` branch. */
function makeNullable(node: JsonSchemaNode): void {
  if (Array.isArray(node.type)) {
    if (!node.type.includes("null")) node.type.push("null");
    return;
  }
  if (typeof node.type === "string") {
    node.type = [node.type, "null"];
    return;
  }
  if (Array.isArray(node.anyOf)) {
    const alreadyNullable = node.anyOf.some((b) => isPlainObject(b) && b.type === "null");
    if (!alreadyNullable) node.anyOf.push({ type: "null" });
    return;
  }
  const original: JsonSchemaNode = {};
  for (const key of Object.keys(node)) {
    original[key] = node[key];
    delete node[key];
  }
  node.anyOf = [original, { type: "null" }];
}

/** True when a property's own JSON Schema node already accepts `null`, independent of whether
 *  `requireEveryPropertyEverywhere` would widen it: a plain `type` array containing `"null"`
 *  (`.nullable()` on a simple type, e.g. `{"type":["string","null"]}`), a bare `{"type":"null"}`,
 *  or an `anyOf` with a `{"type":"null"}` branch (`.nullable()` on an object/array, which
 *  `zod-to-json-schema` represents as `anyOf: [<real schema>, {"type":"null"}]`, verified
 *  empirically). Fix round 1, F2: a property that already accepts null this way has a zod schema
 *  where `null` is a meaningful value (`.nullable()`), not a stand-in for "omitted", so it must
 *  never be stripped from a response the way a forced-nullable-for-strict-mode-only field is. */
function alreadyAcceptsNull(node: JsonSchemaNode): boolean {
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.includes("null")) return true;
  if (Array.isArray(node.anyOf)) {
    return node.anyOf.some((b) => isPlainObject(b) && alreadyAcceptsNull(b));
  }
  return false;
}

/**
 * Tracks, in the same shape as the JSON Schema `requireEveryPropertyEverywhere` builds, exactly
 * which property keys at each level were forced into `required` (and widened to accept `null`)
 * only because OpenRouter's strict mode demands it, as opposed to keys that were always required
 * or were already nullable in the original zod schema. `OpenRouterProvider.complete` walks a
 * parsed response alongside this tree (`stripForcedNulls`) so only a `null` at one of these exact
 * forced positions is treated as "field omitted"; a `null` anywhere else (a genuinely `.nullable()`
 * field, or a value nested somewhere this tree never forced anything) passes through untouched.
 */
type ForcedNullableNode = {
  forcedKeys: Set<string>;
  properties: Record<string, ForcedNullableNode>;
  items?: ForcedNullableNode;
};

function emptyForcedNullableNode(): ForcedNullableNode {
  return { forcedKeys: new Set(), properties: {} };
}

/**
 * OpenAI/Meta-style `strict: true` JSON Schema requires `required` to list every key in
 * `properties`, even ones the zod schema marks `.optional()` (verified live against OpenRouter's
 * Meta backend, `meta/muse-spark-1.3` and `meta/muse-spark-1.3-contributor`: a schema that
 * omitted `confidenceBps`, `VoteV1`'s one optional field, from `required` was rejected with HTTP
 * 400 `"'required' is required to be supplied and to be an array including every key in
 * properties. Missing 'confidenceBps'."`; `anthropic/claude-sonnet-5` on the same account
 * tolerated the omission, so this was silent on the model this adapter happened to be verified
 * against first). The documented workaround for this style of strict mode is to require every
 * key and represent true optionality by widening the property's own type to also allow `null`,
 * but only when it does not already accept `null` (`alreadyAcceptsNull`): a `.nullable()` field
 * is left exactly as `zod-to-json-schema` generated it and is still added to `required` (strict
 * mode's requirement), but is not recorded in `tracking.forcedKeys`, since its own `null` is
 * meaningful and must survive `stripForcedNulls` on the response side untouched.
 *
 * `anyOf`/`oneOf`/`allOf` branches are walked with the *same* tracking node as their parent
 * (rather than a fresh one) because `zod-to-json-schema` represents `.nullable()` on an
 * object/array as `anyOf: [<real object/array schema>, {"type":"null"}]`: the real branch's own
 * `properties` populate this property's tracking node exactly as if there were no `anyOf`
 * wrapper, and the `{"type":"null"}` branch contributes nothing (it has no `.properties`).
 */
function requireEveryPropertyEverywhere(node: unknown, tracking: ForcedNullableNode): void {
  if (!isPlainObject(node)) return;

  if (isPlainObject(node.properties)) {
    const properties = node.properties;
    const originallyRequired = new Set(Array.isArray(node.required) ? (node.required as unknown[]) : []);
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!isPlainObject(propSchema)) continue;
      if (!originallyRequired.has(key) && !alreadyAcceptsNull(propSchema)) {
        tracking.forcedKeys.add(key);
        makeNullable(propSchema);
      }
      const childTracking = tracking.properties[key] ?? emptyForcedNullableNode();
      tracking.properties[key] = childTracking;
      requireEveryPropertyEverywhere(propSchema, childTracking);
    }
    node.required = Object.keys(properties);
  }
  if (Array.isArray(node.items)) {
    // Tuple-style items: no schema this adapter sends today uses this shape. Each element still
    // gets the additionalProperties/required treatment, just with its own untracked (never
    // forced-null-stripped) node, since a tuple position cannot be addressed by property key.
    for (const item of node.items) requireEveryPropertyEverywhere(item, emptyForcedNullableNode());
  } else if (node.items !== undefined) {
    const itemsTracking = tracking.items ?? emptyForcedNullableNode();
    tracking.items = itemsTracking;
    requireEveryPropertyEverywhere(node.items, itemsTracking);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const b of branch) requireEveryPropertyEverywhere(b, tracking);
    }
  }
  for (const key of ["definitions", "$defs"]) {
    const defs = node[key];
    if (isPlainObject(defs)) {
      for (const value of Object.values(defs)) requireEveryPropertyEverywhere(value, emptyForcedNullableNode());
    }
  }
}

/** Undoes `requireEveryPropertyEverywhere`'s nullable widening on the response side, and only
 *  that: a model that returns an explicit JSON `null` for a field `tracking` marks as forced
 *  (widened purely for OpenRouter's strict mode, because the underlying zod field is `.optional()`
 *  and not itself `.nullable()`) is treated the same as if the model had omitted that field, so
 *  `req.schema.safeParse` (the caller's real, unwidened zod schema) sees the same shape it would
 *  from a provider that never had this constraint. A `null` for any other key, at any depth,
 *  including a genuinely `.nullable()` field, is left exactly as returned (fix round 1, F2). */
function stripForcedNulls(value: unknown, tracking: ForcedNullableNode | undefined): unknown {
  if (!tracking) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripForcedNulls(item, tracking.items));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === null && tracking.forcedKeys.has(key)) continue;
      result[key] = stripForcedNulls(v, tracking.properties[key]);
    }
    return result;
  }
  return value;
}

function buildJsonSchema(schema: z.ZodType<unknown>): { schema: Record<string, unknown>; forcedNullable: ForcedNullableNode } {
  // $refStrategy: "none" (fix round 2, F2 follow-up): when a zod schema reuses the same
  // sub-schema instance in two places (e.g. `z.object({ a: Shared, b: Shared })`), the default
  // strategy emits a `$ref` for the repeat occurrence instead of a second inline copy. Neither
  // `forceNoAdditionalPropertiesEverywhere` nor `requireEveryPropertyEverywhere` (nor its
  // `ForcedNullableNode` tracking) follows `$ref`, so the repeated occurrence would keep whatever
  // `required`/nullability the *first* occurrence happened to get and would not be tracked as
  // forced at its own position; a legitimate `null` for an optional field there would then fail
  // to be stripped and the whole response would be reported malformed. Strict mode has no use for
  // `$defs`/`definitions` (the schema is sent inline in one request body every time), so there is
  // no downside to always inlining: this makes `$ref` impossible to emit in the first place,
  // rather than teaching every tree-walker here to resolve it.
  const generated = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  delete generated.$schema;
  forceNoAdditionalPropertiesEverywhere(generated);
  const forcedNullable = emptyForcedNullableNode();
  requireEveryPropertyEverywhere(generated, forcedNullable);
  return { schema: generated, forcedNullable };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Below this much remaining time on the shared `timeoutMs` deadline, the 429/5xx retry is
 *  skipped (fix round 1, F3): retrying anyway risks spending the whole budget on a second attempt
 *  that itself has almost no time to complete. */
const MIN_REMAINING_MS_TO_RETRY = 5_000;

/**
 * `Provider` backed by OpenRouter's OpenAI-compatible `chat/completions` endpoint (controller
 * notes, replacing the brief's `anthropic-api` adapter). Structured output is enforced with
 * `response_format: { type: "json_schema", json_schema: { strict: true, schema } }`; the schema
 * is the caller's zod type converted with `zod-to-json-schema`. `finish_reason: "length"` (output
 * truncated by `maxTokens`) is reported as a `"malformed"` result with `truncated: true` rather
 * than attempting to parse a cut-off string, so `withOneRepair` can ask again with a higher
 * budget. HTTP 429 and 5xx get one retry after `retryBackoffMs`, as long as at least
 * `MIN_REMAINING_MS_TO_RETRY` remains on `req.timeoutMs`'s single shared deadline (fix round 1,
 * F3: `timeoutMs` bounds the whole `complete()` call, including the retry, never a fresh
 * `timeoutMs` per HTTP attempt); every other non-2xx status (including 403 "attestation required"
 * and 404 "model ineligible on this account", both seen live against
 * `meta/muse-spark-1.3-contributor`) is a `"provider"` failure whose `raw` is the response body
 * verbatim, so the caller sees OpenRouter's own message and any `configure_url`.
 */
export class OpenRouterProvider implements Provider {
  readonly name = "openrouter";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffMs: number;
  private readonly onResponseBody: (body: OpenRouterResponseBody) => void;
  private readonly now: () => number;

  constructor(opts: OpenRouterProviderOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_OPENROUTER_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryBackoffMs = opts.retryBackoffMs ?? 300;
    this.onResponseBody = opts.onResponseBody ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
  }

  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const started = this.now();
    const deadline = started + req.timeoutMs;
    const { schema: jsonSchema, forcedNullable } = buildJsonSchema(req.schema as z.ZodType<unknown>);
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: "fleet_output", strict: true, schema: jsonSchema },
      },
    };

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remainingBeforeAttempt = deadline - this.now();
      if (remainingBeforeAttempt <= 0) {
        return { ok: false, error: "timeout", raw: "", latencyMs: this.now() - started };
      }

      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": HTTP_REFERER,
            "X-Title": X_TITLE,
          },
          body: JSON.stringify(body),
          // One deadline for the whole call (F3): each attempt gets whatever is left of
          // req.timeoutMs, never a fresh req.timeoutMs of its own.
          signal: AbortSignal.timeout(remainingBeforeAttempt),
        });
      } catch (err) {
        const latencyMs = this.now() - started;
        if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
          return { ok: false, error: "timeout", raw: "", latencyMs };
        }
        return { ok: false, error: "provider", raw: errorMessage(err), latencyMs };
      }

      if (!res.ok) {
        const remainingForRetry = deadline - this.now();
        if (isRetryableStatus(res.status) && attempt < maxAttempts && remainingForRetry >= MIN_REMAINING_MS_TO_RETRY) {
          await sleep(this.retryBackoffMs);
          continue;
        }
        const text = await res.text().catch(() => "");
        return { ok: false, error: "provider", raw: text, latencyMs: this.now() - started };
      }

      const latencyMs = this.now() - started;
      const payload = (await res.json()) as OpenRouterResponseBody;
      this.onResponseBody(payload);

      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? "";
      const usage: Usage = {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        model: payload.model ?? this.model,
      };

      if (choice?.finish_reason === "length") {
        return { ok: false, error: "malformed", raw: content, usage, latencyMs, truncated: true };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return { ok: false, error: "malformed", raw: content, usage, latencyMs };
      }

      // Undo requireEveryPropertyEverywhere's null-for-optional widening before validating
      // against the caller's real (unwidened) zod schema; only the keys it actually forced, per
      // forcedNullable, are stripped (fix round 1, F2).
      const result = req.schema.safeParse(stripForcedNulls(parsed, forcedNullable));
      if (!result.success) {
        return { ok: false, error: "malformed", raw: content, usage, latencyMs };
      }

      return { ok: true, value: result.data, usage, latencyMs, raw: content };
    }

    // Unreachable: the loop above always returns on its final attempt.
    return { ok: false, error: "provider", raw: "", latencyMs: this.now() - started };
  }
}
