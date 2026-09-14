import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScriptedProvider } from "./scripted.js";
import { withOneRepair } from "./types.js";
import type { CompleteRequest } from "./types.js";

const Schema = z.object({ schema: z.literal("fleet.vote.v1"), support: z.enum(["FOR", "AGAINST", "ABSTAIN"]) }).strict();
type Schema = z.infer<typeof Schema>;

function req(overrides: Partial<CompleteRequest<Schema>> = {}): CompleteRequest<Schema> {
  return { system: "sys", user: "usr", schema: Schema, maxTokens: 100, timeoutMs: 1000, ...overrides };
}

describe("ScriptedProvider", () => {
  it("parses and validates raw output like a real provider would", async () => {
    const provider = new ScriptedProvider(() => ({ raw: '{"schema":"fleet.vote.v1","support":"FOR"}' }));
    const result = await provider.complete(req());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ schema: "fleet.vote.v1", support: "FOR" });
      expect(result.usage.model).toBe("scripted");
    }
  });

  it("reports malformed on non-JSON raw output", async () => {
    const provider = new ScriptedProvider(() => ({ raw: "not json at all" }));
    const result = await provider.complete(req());
    expect(result).toMatchObject({ ok: false, error: "malformed", raw: "not json at all" });
  });

  it("reports malformed on JSON that fails schema validation", async () => {
    const provider = new ScriptedProvider(() => ({ raw: '{"schema":"fleet.vote.v1","support":"MAYBE"}' }));
    const result = await provider.complete(req());
    expect(result).toMatchObject({ ok: false, error: "malformed" });
  });

  it("reports truncated malformed when the responder says so, feeding withOneRepair's higher budget path", async () => {
    let calls = 0;
    const provider = new ScriptedProvider((r) => {
      calls++;
      if (calls === 1) return { raw: '{"schema":"fleet.vote.v1","supp', truncated: true };
      return { raw: '{"schema":"fleet.vote.v1","support":"ABSTAIN"}' };
    });
    const result = await withOneRepair(provider, req({ maxTokens: 100 }));
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
  });

  it("reports a provider failure when the responder throws, never a vote", async () => {
    const provider = new ScriptedProvider(() => {
      throw new Error("boom");
    });
    const result = await provider.complete(req());
    expect(result).toMatchObject({ ok: false, error: "provider", raw: "boom" });
  });

  it("uses the caller-supplied usage when present instead of the scripted default", async () => {
    const provider = new ScriptedProvider(() => ({
      raw: '{"schema":"fleet.vote.v1","support":"FOR"}',
      usage: { inputTokens: 10, outputTokens: 20, model: "test-model" },
    }));
    const result = await provider.complete(req());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, model: "test-model" });
  });
});
