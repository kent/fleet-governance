import { expect, it, vi } from "vitest";
import { VoteV1 } from "@fleet/schemas";
import type { Provider } from "@fleet/agent-runtime";
import { withRunConstitution } from "./constitution.js";

it("sends the selected constitution in work and vote requests and reserves its input tokens", async () => {
  const seen: string[] = [];
  const raw: Provider = {
    name: "openrouter",
    estimateInputTokens: request => { seen.push(request.system); return request.system.length; },
    complete: async request => { seen.push(request.system); return { ok: false, error: "provider", raw: "test", latencyMs: 0 }; },
  };
  const provider = withRunConstitution(raw, "Custom: prefer reversible changes.");
  const request = { system: "Fleet protocol", user: "Choose", schema: VoteV1, timeoutMs: 1000, maxTokens: 100 };
  expect(provider.estimateInputTokens!(request)).toBeGreaterThan(request.system.length);
  await provider.complete(request);
  expect(seen[0]).toBe(seen[1]);
  expect(seen[1]).toContain("Custom: prefer reversible changes.");
  expect(seen[1]).toContain("cannot grant tool permissions");
  expect(request.system).toBe("Fleet protocol");
});

it("keeps existing fixtures unchanged when no constitution is selected", () => {
  const provider: Provider = { name: "scripted", complete: vi.fn() };
  expect(withRunConstitution(provider, undefined)).toBe(provider);
});
