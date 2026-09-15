import { describe, expect, it } from "vitest";
import { parseDecisionDescription } from "@fleet/sdk";
import { buildTriggerDecision } from "../pipeline/fixture-runner.js";
import { simulationChallenge } from "./simulation-challenge.js";
import { safeFailure } from "./simulation-diagnostics.js";

describe("real simulation preparation", () => {
  it("builds a bounded, parseable exact proposal without scripting any ballot", async () => {
    const fixture = simulationChallenge("run-00000000-0000-0000-0000-000000000000");
    const context = { client: { getTask: async () => ({ charterVersion: 1 }), listMembers: async () => [{ agentId: 0, manifest: '{"role":"planner"}' }] } } as unknown as Parameters<typeof buildTriggerDecision>[0];
    const built = await buildTriggerDecision(context, 99n, fixture);
    expect(Buffer.byteLength(built.description)).toBeLessThanOrEqual(4096);
    expect(parseDecisionDescription(built.description).decision).toEqual(built.decision);
    expect(built.decision.action?.target).toContain("private-reference.test");
    expect(fixture.script).toEqual({});
  });

  it("never emits provider messages or credential-bearing error fields", () => {
    const failure = { name: "HttpRequestError", status: 429, message: "secret", url: "https://secret", cause: { name: "Error", code: -32000, message: "secret" } };
    expect(safeFailure(failure)).toEqual([{ type: "HttpRequestError", status: 429 }, { type: "Error", code: -32000 }]);
  });
});
