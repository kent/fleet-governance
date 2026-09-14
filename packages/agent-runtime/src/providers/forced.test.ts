import { describe, expect, it } from "vitest";
import { z } from "zod";
import { forceMalformedProvider } from "./forced.js";
import { ScriptedProvider } from "./scripted.js";
import { withOneRepair } from "./types.js";

const Schema = z.object({ ok: z.boolean() }).strict();

function request(): { system: string; user: string; schema: typeof Schema; maxTokens: number; timeoutMs: number } {
  return { system: "s", user: "u", schema: Schema, maxTokens: 100, timeoutMs: 1000 };
}

describe("forceMalformedProvider", () => {
  it("returns a malformed result for every call, without asking the inner provider", async () => {
    let innerCalls = 0;
    const inner = new ScriptedProvider(() => {
      innerCalls += 1;
      return { raw: JSON.stringify({ ok: true }) };
    });

    const forced = forceMalformedProvider(inner, 2);
    const first = await forced.complete(request());
    const second = await forced.complete(request());

    expect(innerCalls).toBe(0);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(first.ok === false && first.error).toBe("malformed");
    expect(first.raw).toBe("forced-malformed");
  });

  it("keeps the inner provider's name, so a job record still says which adapter was configured", () => {
    expect(forceMalformedProvider(new ScriptedProvider(() => ({ raw: "{}" })), 0).name).toBe("scripted");
  });

  it("stays malformed through withOneRepair's single retry, so no repaired reply sneaks past it", async () => {
    const forced = forceMalformedProvider(new ScriptedProvider(() => ({ raw: JSON.stringify({ ok: true }) })), 1);

    const result = await withOneRepair(forced, request());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("malformed");
  });

  it("never reports truncation, so the repair retry does not ask for a bigger token budget", async () => {
    const forced = forceMalformedProvider(new ScriptedProvider(() => ({ raw: "{}" })), 3);
    const result = await forced.complete(request());
    expect(result.ok === false && result.truncated).toBeUndefined();
  });
});
