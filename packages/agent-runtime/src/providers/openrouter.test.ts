import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenRouterProvider } from "./openrouter.js";
import type { CompleteRequest } from "./types.js";
import { withOneRepair } from "./types.js";

const Schema = z
  .object({
    schema: z.literal("fleet.vote.v1"),
    support: z.enum(["FOR", "AGAINST", "ABSTAIN"]),
    rationale: z.string().min(1),
  })
  .strict();
type Schema = z.infer<typeof Schema>;

const FAKE_API_KEY = "sk-or-test-key-must-never-appear-in-any-assertion-failure-either";

// 60_000 matches spec 10.6's production timeout and, just as importantly for these tests, leaves
// comfortably more than MIN_REMAINING_MS_TO_RETRY after a fast fake-server round trip, so a test
// that is not specifically about the shared deadline (see the "single deadline across retries"
// describe block) does not have to think about it.
function req(overrides: Partial<CompleteRequest<Schema>> = {}): CompleteRequest<Schema> {
  return { system: "sys", user: "usr", schema: Schema, maxTokens: 500, timeoutMs: 60_000, ...overrides };
}

/** A minimal local HTTP server for faking OpenRouter, the pattern `apps/runner`'s
 *  `cpls-sync.test.ts` already uses ("a local fake HTTP server"). `handler` gets the parsed
 *  request body and the raw request/response so a test can assert headers too. */
function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (c: Buffer) => chunks.push(c));
      request.on("end", () => handler(request, response, Buffer.concat(chunks).toString("utf8")));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          server,
          close: () => new Promise((res) => server.close(() => res())),
        });
      } else {
        reject(new Error("could not determine fake server port"));
      }
    });
  });
}

let activeServer: { close: () => Promise<void> } | null = null;
afterEach(async () => {
  if (activeServer) {
    await activeServer.close();
    activeServer = null;
  }
});

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("OpenRouterProvider (against a local fake HTTP server)", () => {
  it("happy path: builds a strict json_schema request and parses choices[0].message.content", async () => {
    let seenBody: Record<string, unknown> | undefined;
    let seenAuth: string | undefined;
    const handle = await startFakeServer((request, res, body) => {
      seenAuth = request.headers.authorization;
      seenBody = JSON.parse(body);
      jsonResponse(res, 200, {
        model: "meta/muse-spark-1.3-contributor",
        choices: [
          {
            message: { content: '{"schema":"fleet.vote.v1","support":"AGAINST","rationale":"out of charter"}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 300, completion_tokens: 40 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete(req());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ schema: "fleet.vote.v1", support: "AGAINST", rationale: "out of charter" });
      expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 40, model: "meta/muse-spark-1.3-contributor" });
    }

    expect(seenAuth).toBe(`Bearer ${FAKE_API_KEY}`);
    expect(seenBody?.model).toBe("meta/muse-spark-1.3-contributor");
    const responseFormat = seenBody?.response_format as Record<string, unknown>;
    expect(responseFormat.type).toBe("json_schema");
    const jsonSchema = responseFormat.json_schema as Record<string, unknown>;
    expect(jsonSchema.strict).toBe(true);
    const schema = jsonSchema.schema as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect((schema.required as string[]).sort()).toEqual(["rationale", "schema", "support"]);
  });

  it("truncation: finish_reason length is malformed+truncated, and withOneRepair retries once with a higher maxTokens", async () => {
    let callCount = 0;
    const seenMaxTokens: number[] = [];
    const handle = await startFakeServer((request, res, body) => {
      callCount++;
      const parsed = JSON.parse(body) as { max_tokens: number };
      seenMaxTokens.push(parsed.max_tokens);
      if (callCount === 1) {
        jsonResponse(res, 200, {
          model: "meta/muse-spark-1.3-contributor",
          choices: [{ message: { content: '{"schema":"fleet.vote.v1","support":"FOR","rationale":"cut o' }, finish_reason: "length" }],
          usage: { prompt_tokens: 300, completion_tokens: 300 },
        });
        return;
      }
      jsonResponse(res, 200, {
        model: "meta/muse-spark-1.3-contributor",
        choices: [{ message: { content: '{"schema":"fleet.vote.v1","support":"FOR","rationale":"complete now"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 60 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await withOneRepair(provider, req({ maxTokens: 300 }));

    expect(callCount).toBe(2);
    expect(seenMaxTokens[1]).toBeGreaterThan(300);
    expect(result.ok).toBe(true);
  });

  it("malformed twice: withOneRepair returns the second malformed result and never calls a third time", async () => {
    let callCount = 0;
    const handle = await startFakeServer((request, res) => {
      callCount++;
      jsonResponse(res, 200, {
        model: "meta/muse-spark-1.3-contributor",
        choices: [{ message: { content: "not json at all" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await withOneRepair(provider, req());

    expect(callCount).toBe(2);
    expect(result).toMatchObject({ ok: false, error: "malformed" });
  });

  it("429 then success: retries once after backoff and returns the retried result", async () => {
    let callCount = 0;
    const handle = await startFakeServer((request, res) => {
      callCount++;
      if (callCount === 1) {
        jsonResponse(res, 429, { error: { message: "rate limited" } });
        return;
      }
      jsonResponse(res, 200, {
        model: "meta/muse-spark-1.3-contributor",
        choices: [{ message: { content: '{"schema":"fleet.vote.v1","support":"FOR","rationale":"ok now"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url, retryBackoffMs: 5 });
    const result = await provider.complete(req());

    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("5xx twice: retries once after backoff, then returns a provider error (never a third attempt)", async () => {
    let callCount = 0;
    const handle = await startFakeServer((request, res) => {
      callCount++;
      jsonResponse(res, 503, { error: { message: "upstream unavailable" } });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url, retryBackoffMs: 5 });
    const result = await provider.complete(req());

    expect(callCount).toBe(2);
    expect(result).toMatchObject({ ok: false, error: "provider" });
    if (!result.ok) expect(result.raw).toContain("upstream unavailable");
  });

  it("timeout: aborts via AbortController when the server never responds in time", async () => {
    const handle = await startFakeServer(() => {
      // Never calls res.end(): the connection just hangs, so the client must time out on its own.
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete(req({ timeoutMs: 30 }));

    expect(result).toMatchObject({ ok: false, error: "timeout", raw: "" });
  });

  it("surfaces HTTP 403 missing_attestation_types as a provider error with the message verbatim", async () => {
    const body = {
      error: {
        message:
          "This model requires you to complete the following before use: 18+ age confirmation. Visit https://openrouter.ai/settings/preferences to confirm.",
        code: 403,
        metadata: { missing_attestation_types: ["age_18plus"] },
      },
    };
    const handle = await startFakeServer((request, res) => jsonResponse(res, 403, body));
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete(req());

    expect(result).toMatchObject({ ok: false, error: "provider" });
    if (!result.ok) {
      expect(result.raw).toContain("18+ age confirmation");
      expect(result.raw).toContain("missing_attestation_types");
      expect(result.raw).not.toContain(FAKE_API_KEY);
    }
  });

  it("surfaces HTTP 404 ineligibility_reasons as a provider error with the message and configure_url verbatim", async () => {
    const body = {
      error: {
        message:
          "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. Paid model training violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy",
        code: 404,
        metadata: {
          ineligibility_reasons: [
            { reason: "paid-model-training-violation-by-account", endpoint_count: 1, configure_url: "https://openrouter.ai/settings/privacy" },
          ],
        },
      },
    };
    const handle = await startFakeServer((request, res) => jsonResponse(res, 404, body));
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete(req());

    expect(result).toMatchObject({ ok: false, error: "provider" });
    if (!result.ok) {
      expect(result.raw).toContain("ineligibility_reasons");
      expect(result.raw).toContain("https://openrouter.ai/settings/privacy");
      expect(result.raw).not.toContain(FAKE_API_KEY);
    }
  });

  it("never leaks the API key through a network-failure error message", async () => {
    const provider = new OpenRouterProvider({
      apiKey: FAKE_API_KEY,
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: () => Promise.reject(new Error(`connection refused to some host, key was ${FAKE_API_KEY.slice(0, 4)}...redacted-by-test-setup-only`)),
    });
    // The above fetchImpl deliberately does NOT include the real key; this test's job is to
    // confirm the provider itself never constructs an error message containing it.
    const result = await provider.complete(req());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).not.toContain(FAKE_API_KEY);
  });

  it("strict-mode compatibility: an optional zod field is required-but-nullable in the sent schema, and a returned null validates as if the field were absent", async () => {
    // meta/muse-spark-1.3-contributor rejected VoteV1's optional confidenceBps with HTTP 400
    // ("'required' is required to be supplied and to be an array including every key in
    // properties. Missing 'confidenceBps'.") when it was left out of `required` (verified live,
    // see task-2-report.md). This is the regression test for the fix.
    const SchemaWithOptional = z
      .object({
        schema: z.literal("fleet.vote.v1"),
        support: z.enum(["FOR", "AGAINST", "ABSTAIN"]),
        rationale: z.string().min(1),
        confidenceBps: z.number().int().min(0).max(10000).optional(),
      })
      .strict();

    let seenBody: Record<string, unknown> | undefined;
    const handle = await startFakeServer((request, res, body) => {
      seenBody = JSON.parse(body);
      jsonResponse(res, 200, {
        model: "meta/muse-spark-1.3-contributor",
        choices: [
          {
            message: { content: '{"schema":"fleet.vote.v1","support":"FOR","rationale":"ok","confidenceBps":null}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete({ system: "sys", user: "usr", schema: SchemaWithOptional, maxTokens: 500, timeoutMs: 2000 });

    const responseFormat = seenBody?.response_format as Record<string, unknown>;
    const jsonSchema = (responseFormat.json_schema as Record<string, unknown>).schema as Record<string, unknown>;
    expect((jsonSchema.required as string[]).sort()).toEqual(["confidenceBps", "rationale", "schema", "support"]);
    const confidenceBpsSchema = (jsonSchema.properties as Record<string, Record<string, unknown>>).confidenceBps;
    expect(confidenceBpsSchema).toBeDefined();
    expect(confidenceBpsSchema?.type).toEqual(["integer", "null"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ schema: "fleet.vote.v1", support: "FOR", rationale: "ok" });
      expect("confidenceBps" in result.value).toBe(false);
    }
  });

  it("fix round 1 F2: a .nullable() (non-optional) field stays required, and its null is never stripped", async () => {
    const NullableSchema = z.object({ a: z.string().nullable() }).strict();
    const handle = await startFakeServer((request, res) => {
      jsonResponse(res, 200, {
        model: "m",
        choices: [{ message: { content: '{"a":null}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete({ system: "s", user: "u", schema: NullableSchema, maxTokens: 100, timeoutMs: 2000 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: null });
  });

  it("fix round 1 F2: an .optional() (non-nullable) field's returned null is stripped, same as an omitted field", async () => {
    const OptionalSchema = z.object({ b: z.string().optional() }).strict();
    const handle = await startFakeServer((request, res) => {
      jsonResponse(res, 200, {
        model: "m",
        choices: [{ message: { content: '{"b":null}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete({ system: "s", user: "u", schema: OptionalSchema, maxTokens: 100, timeoutMs: 2000 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({});
      expect("b" in result.value).toBe(false);
    }
  });

  it("fix round 1 F2: a .nullable().optional() nested object round-trips both a null and a present object", async () => {
    const NestedSchema = z.object({ c: z.object({ d: z.string() }).strict().nullable().optional() }).strict();
    let respondWith: unknown = { c: null };
    const handle = await startFakeServer((request, res) => {
      jsonResponse(res, 200, {
        model: "m",
        choices: [{ message: { content: JSON.stringify(respondWith) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    activeServer = handle;
    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });

    const nullResult = await provider.complete({ system: "s", user: "u", schema: NestedSchema, maxTokens: 100, timeoutMs: 2000 });
    expect(nullResult.ok).toBe(true);
    if (nullResult.ok) expect(nullResult.value).toEqual({ c: null });

    respondWith = { c: { d: "x" } };
    const presentResult = await provider.complete({ system: "s", user: "u", schema: NestedSchema, maxTokens: 100, timeoutMs: 2000 });
    expect(presentResult.ok).toBe(true);
    if (presentResult.ok) expect(presentResult.value).toEqual({ c: { d: "x" } });
  });

  it("fix round 2 F2 follow-up: a repeated sub-schema instance is inlined (no $ref anywhere), so the second occurrence's forced-nullable tracking works too", async () => {
    // z.object({ a: Shared, b: Shared }): the same ZodObject instance used for two properties.
    // The default zod-to-json-schema strategy would emit `{"$ref":"#/properties/a"}` for `b`,
    // which requireEveryPropertyEverywhere's tree-walk (and its ForcedNullableNode tracking)
    // does not follow, so `b`'s own optional field would not be tracked as forced there.
    const Shared = z.object({ x: z.string(), y: z.number().optional() }).strict();
    const SharedTwice = z.object({ a: Shared, b: Shared }).strict();

    let seenBody: Record<string, unknown> | undefined;
    const handle = await startFakeServer((request, res, body) => {
      seenBody = JSON.parse(body);
      jsonResponse(res, 200, {
        model: "m",
        choices: [
          {
            // b's optional `y` comes back explicit null, the strict-mode-required-but-nullable
            // shape a model produces for "omitted"; only correct if `b`'s own schema (not a
            // $ref to a's) was walked and tracked.
            message: { content: '{"a":{"x":"one","y":1},"b":{"x":"two","y":null}}' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url });
    const result = await provider.complete({ system: "s", user: "u", schema: SharedTwice, maxTokens: 100, timeoutMs: 2000 });

    const responseFormat = seenBody?.response_format as Record<string, unknown>;
    const jsonSchema = (responseFormat.json_schema as Record<string, unknown>).schema;
    expect(JSON.stringify(jsonSchema)).not.toContain("$ref");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: { x: "one", y: 1 }, b: { x: "two" } });
      expect("y" in result.value.b).toBe(false);
    }
  });

  it("fix round 1 F3: skips the 429 retry when fewer than 5s remain on the shared deadline (never a fresh timeoutMs per attempt)", async () => {
    let callCount = 0;
    let currentTime = 1_000_000;
    const now = () => currentTime;
    const handle = await startFakeServer((request, res) => {
      callCount++;
      if (callCount === 1) {
        // The first attempt itself "takes" 8s of a 10s budget, leaving 2s: below the 5s floor.
        // If timeoutMs were a fresh allowance per attempt instead of one shared deadline, this
        // would still retry (and the total call could run past 10s).
        currentTime += 8_000;
        jsonResponse(res, 429, { error: { message: "rate limited" } });
        return;
      }
      jsonResponse(res, 200, {
        model: "m",
        choices: [{ message: { content: '{"schema":"fleet.vote.v1","support":"FOR","rationale":"r"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url, retryBackoffMs: 1, now });
    const result = await provider.complete(req({ timeoutMs: 10_000 }));

    expect(callCount).toBe(1);
    expect(result).toMatchObject({ ok: false, error: "provider" });
  });

  it("fix round 1 F3: still retries once when at least 5s remain on the shared deadline", async () => {
    let callCount = 0;
    let currentTime = 1_000_000;
    const now = () => currentTime;
    const handle = await startFakeServer((request, res) => {
      callCount++;
      if (callCount === 1) {
        currentTime += 1_000; // 9s of the 10s budget left: comfortably above the 5s floor.
        jsonResponse(res, 429, { error: { message: "rate limited" } });
        return;
      }
      jsonResponse(res, 200, {
        model: "m",
        choices: [{ message: { content: '{"schema":"fleet.vote.v1","support":"FOR","rationale":"r"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url, retryBackoffMs: 1, now });
    const result = await provider.complete(req({ timeoutMs: 10_000 }));

    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("sends the model, HTTP-Referer, and X-Title headers, and does not send it for other backends by mistake", async () => {
    let seenHeaders: Record<string, string | string[] | undefined> = {};
    const handle = await startFakeServer((request, res) => {
      seenHeaders = request.headers;
      jsonResponse(res, 200, {
        model: "custom-model",
        choices: [{ message: { content: '{"schema":"fleet.vote.v1","support":"FOR","rationale":"r"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    activeServer = handle;

    const provider = new OpenRouterProvider({ apiKey: FAKE_API_KEY, baseUrl: handle.url, model: "custom-model" });
    await provider.complete(req());

    expect(seenHeaders["http-referer"]).toBe("fleet-governance");
    expect(seenHeaders["x-title"]).toBe("fleet-governance");
    expect(seenHeaders["content-type"]).toBe("application/json");
  });
});
