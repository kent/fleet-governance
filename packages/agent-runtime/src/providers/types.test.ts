import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withOneRepair } from "./types.js";
import type { CompleteRequest, CompleteResult, Provider } from "./types.js";

const Schema = z.object({ ok: z.literal(true), value: z.string() }).strict();
type Schema = z.infer<typeof Schema>;

function baseReq(overrides: Partial<CompleteRequest<Schema>> = {}): CompleteRequest<Schema> {
  return {
    system: "system prompt",
    user: "user prompt",
    schema: Schema,
    maxTokens: 500,
    timeoutMs: 1000,
    ...overrides,
  };
}

function fakeProvider(complete: Provider["complete"]): Provider {
  return { name: "scripted", complete };
}

describe("withOneRepair", () => {
  it("returns the first result unchanged when it already succeeds", async () => {
    const complete = vi.fn(async (): Promise<CompleteResult<Schema>> => ({
      ok: true,
      value: { ok: true, value: "first try" },
      usage: { inputTokens: 1, outputTokens: 1, model: "m" },
      latencyMs: 5,
      raw: '{"ok":true,"value":"first try"}',
    }));
    const provider = fakeProvider(complete);

    const result = await withOneRepair(provider, baseReq());

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      value: { ok: true, value: "first try" },
      usage: { inputTokens: 1, outputTokens: 1, model: "m" },
      latencyMs: 5,
      raw: '{"ok":true,"value":"first try"}',
    });
  });

  it("retries exactly once on malformed and succeeds with the repaired prompt", async () => {
    const seenPrompts: string[] = [];
    const complete = vi.fn(async (req: CompleteRequest<Schema>): Promise<CompleteResult<Schema>> => {
      seenPrompts.push(req.user);
      if (seenPrompts.length === 1) {
        return { ok: false, error: "malformed", raw: "not json", latencyMs: 3 };
      }
      return {
        ok: true,
        value: { ok: true, value: "repaired" },
        usage: { inputTokens: 2, outputTokens: 2, model: "m" },
        latencyMs: 4,
        raw: '{"ok":true,"value":"repaired"}',
      };
    });
    const provider = fakeProvider(complete);

    const result = await withOneRepair(provider, baseReq());

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    // The repair prompt must carry the original prompt plus an explanation of what went wrong,
    // and it must include the zod/parse-error detail so the model knows what to fix.
    expect(seenPrompts[1]).toContain("user prompt");
    expect(seenPrompts[1]).toContain("YOUR PREVIOUS RESPONSE FAILED VALIDATION");
    expect(seenPrompts[1]).toContain("not valid JSON");
  });

  it("never makes a third attempt: two malformed results in a row return the second, unrepaired further", async () => {
    const complete = vi.fn(async (): Promise<CompleteResult<Schema>> => ({
      ok: false,
      error: "malformed",
      raw: "still not json",
      latencyMs: 2,
    }));
    const provider = fakeProvider(complete);

    const result = await withOneRepair(provider, baseReq());

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ok: false, error: "malformed", raw: "still not json", latencyMs: 2 });
  });

  it("does not retry a timeout", async () => {
    const complete = vi.fn(async (): Promise<CompleteResult<Schema>> => ({
      ok: false,
      error: "timeout",
      raw: "",
      latencyMs: 1000,
    }));
    const provider = fakeProvider(complete);

    const result = await withOneRepair(provider, baseReq());

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("timeout");
  });

  it("does not retry a provider transport error", async () => {
    const complete = vi.fn(async (): Promise<CompleteResult<Schema>> => ({
      ok: false,
      error: "provider",
      raw: "HTTP 500",
      latencyMs: 10,
    }));
    const provider = fakeProvider(complete);

    const result = await withOneRepair(provider, baseReq());

    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("provider");
  });

  it("raises maxTokens on the retry when the first failure was truncation", async () => {
    const seenMaxTokens: number[] = [];
    const complete = vi.fn(async (req: CompleteRequest<Schema>): Promise<CompleteResult<Schema>> => {
      seenMaxTokens.push(req.maxTokens);
      if (seenMaxTokens.length === 1) {
        return { ok: false, error: "malformed", raw: '{"ok":true,"value":"cut off', latencyMs: 3, truncated: true };
      }
      return {
        ok: true,
        value: { ok: true, value: "full" },
        usage: { inputTokens: 3, outputTokens: 3, model: "m" },
        latencyMs: 4,
        raw: '{"ok":true,"value":"full"}',
      };
    });
    const provider = fakeProvider(complete);

    const result = await withOneRepair(provider, baseReq({ maxTokens: 500 }));

    expect(seenMaxTokens[0]).toBe(500);
    expect(seenMaxTokens[1]).toBeGreaterThan(500);
    expect(result.ok).toBe(true);
  });

  it("does not raise maxTokens on the retry when the first failure was not truncation", async () => {
    const seenMaxTokens: number[] = [];
    const complete = vi.fn(async (req: CompleteRequest<Schema>): Promise<CompleteResult<Schema>> => {
      seenMaxTokens.push(req.maxTokens);
      return { ok: false, error: "malformed", raw: "garbage", latencyMs: 1 };
    });
    const provider = fakeProvider(complete);

    await withOneRepair(provider, baseReq({ maxTokens: 500 }));

    expect(seenMaxTokens).toEqual([500, 500]);
  });

  it("describes a schema mismatch (valid JSON, wrong shape) distinctly from invalid JSON", async () => {
    const seenPrompts: string[] = [];
    const complete = vi.fn(async (req: CompleteRequest<Schema>): Promise<CompleteResult<Schema>> => {
      seenPrompts.push(req.user);
      if (seenPrompts.length === 1) {
        return { ok: false, error: "malformed", raw: '{"ok":true,"value":123}', latencyMs: 1 };
      }
      return {
        ok: true,
        value: { ok: true, value: "fixed" },
        usage: { inputTokens: 1, outputTokens: 1, model: "m" },
        latencyMs: 1,
        raw: '{"ok":true,"value":"fixed"}',
      };
    });
    const provider = fakeProvider(complete);

    await withOneRepair(provider, baseReq());

    expect(seenPrompts[1]).toContain("valid JSON but did not match the required schema");
  });
});
