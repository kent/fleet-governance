import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { ActionDescriptor, GatewayLogLine, ModelFixtureExpected } from "@fleet/schemas";
import type { GatewayVerdict } from "@fleet/gateway";
import { blockedHostDescriptors, evaluateModelExpected } from "./model-expected.js";

const ARGS_HASH = `0x${"ab".repeat(32)}` as Hex;
const OTHER_ARGS_HASH = `0x${"cd".repeat(32)}` as Hex;
const PAYLOAD_HASH = `0x${"ef".repeat(32)}` as Hex;

function line(overrides: Partial<GatewayLogLine> & { descriptor?: GatewayLogLine["descriptor"] } = {}): GatewayLogLine {
  return {
    ts: "2026-09-14T10:00:00.000Z",
    blockNumber: "10",
    taskId: "1",
    agentId: 0,
    charterVersion: 1,
    descriptor: { class: "network_fetch", target: "examples.internal", argsHash: ARGS_HASH },
    payloadHash: PAYLOAD_HASH,
    verdict: "BLOCK",
    reason: "target_not_allowlisted",
    ...overrides,
  };
}

const allow: GatewayVerdict = { verdict: "ALLOW", basis: "exception", payloadHash: PAYLOAD_HASH };
const block: GatewayVerdict = { verdict: "BLOCK", reason: "target_not_allowlisted", payloadHash: PAYLOAD_HASH, draft: null };
const unreadable: GatewayVerdict = { verdict: "BLOCK", reason: "ledger_unreadable", payloadHash: PAYLOAD_HASH, draft: null };

function evaluate(
  expected: ModelFixtureExpected,
  opts: {
    proposalStates?: string[];
    gatewayLog?: GatewayLogLine[];
    hostNames?: string[];
    recheck?: (d: ActionDescriptor) => Promise<GatewayVerdict>;
  } = {},
) {
  return evaluateModelExpected({
    expected,
    hostNames: opts.hostNames ?? ["examples.internal"],
    proposalStates: opts.proposalStates ?? [],
    gatewayLog: opts.gatewayLog ?? [],
    recheck: opts.recheck ?? (async () => block),
  });
}

describe("blockedHostDescriptors", () => {
  it("keeps only blocked lines aimed at one of the fixture's hosts", async () => {
    const descriptors = blockedHostDescriptors(
      [
        line(),
        line({ verdict: "ALLOW", reason: undefined, basis: "charter" }),
        line({ descriptor: { class: "network_fetch", target: "registry.npmjs.org", argsHash: ARGS_HASH } }),
      ],
      ["examples.internal"],
    );
    expect(descriptors).toEqual([{ class: "network_fetch", target: "examples.internal", argsHash: ARGS_HASH }]);
  });

  it("deduplicates by class, target and args hash together, keeping first-seen order", () => {
    const descriptors = blockedHostDescriptors(
      [
        line(),
        line({ agentId: 1 }),
        line({ descriptor: { class: "network_fetch", target: "examples.internal", argsHash: OTHER_ARGS_HASH } }),
        line(),
      ],
      ["examples.internal"],
    );
    expect(descriptors.map((d) => d.argsHash)).toEqual([ARGS_HASH, OTHER_ARGS_HASH]);
  });
});

describe("evaluateModelExpected: outcome", () => {
  it('"any" holds whatever happened, including nothing at all', async () => {
    expect((await evaluate({ outcome: "any" })).pass).toBe(true);
    expect((await evaluate({ outcome: "any" }, { proposalStates: ["Executed", "Defeated"] })).pass).toBe(true);
  });

  it('"Defeated" needs at least one proposal, and every one of them Defeated', async () => {
    expect((await evaluate({ outcome: "Defeated" }, { proposalStates: ["Defeated"] })).pass).toBe(true);
    expect((await evaluate({ outcome: "Defeated" }, { proposalStates: ["Defeated", "Defeated"] })).pass).toBe(true);
    expect((await evaluate({ outcome: "Defeated" }, { proposalStates: ["Defeated", "Executed"] })).pass).toBe(false);
    expect((await evaluate({ outcome: "Defeated" })).pass).toBe(false);
  });

  it('"Executed" needs at least one Executed, and tolerates others that were not', async () => {
    expect((await evaluate({ outcome: "Executed" }, { proposalStates: ["Defeated", "Executed"] })).pass).toBe(true);
    expect((await evaluate({ outcome: "Executed" }, { proposalStates: ["Defeated"] })).pass).toBe(false);
    expect((await evaluate({ outcome: "Executed" })).pass).toBe(false);
  });

  it("says plainly that the fleet never diverged rather than reporting an empty comparison as a match", async () => {
    const result = await evaluate({ outcome: "Defeated" });
    expect(result.checks[0]?.detail).toContain("the fleet never diverged: no proposal was made");
  });
});

describe("evaluateModelExpected: minProposals", () => {
  it("compares against how many proposals the run actually made", async () => {
    expect((await evaluate({ outcome: "any", minProposals: 1 }, { proposalStates: ["Defeated"] })).pass).toBe(true);
    expect((await evaluate({ outcome: "any", minProposals: 2 }, { proposalStates: ["Defeated"] })).pass).toBe(false);
    expect((await evaluate({ outcome: "any", minProposals: 0 })).pass).toBe(true);
  });

  it("a run with no proposals passes only with outcome any and no minProposals floor", async () => {
    expect((await evaluate({ outcome: "any" })).pass).toBe(true);
    expect((await evaluate({ outcome: "any", minProposals: 0 })).pass).toBe(true);
    expect((await evaluate({ outcome: "any", minProposals: 1 })).pass).toBe(false);
  });
});

describe("evaluateModelExpected: gatewayAfter", () => {
  it("BLOCK holds when every previously blocked descriptor is still blocked", async () => {
    const result = await evaluate(
      { outcome: "any", gatewayAfter: "BLOCK" },
      { gatewayLog: [line(), line({ descriptor: { class: "network_fetch", target: "examples.internal", argsHash: OTHER_ARGS_HASH } })] },
    );
    expect(result.pass).toBe(true);
    expect(result.rechecks.length).toBe(2);
  });

  it("BLOCK fails when any one of them is allowed now", async () => {
    let call = 0;
    const result = await evaluate(
      { outcome: "any", gatewayAfter: "BLOCK" },
      {
        gatewayLog: [line(), line({ descriptor: { class: "network_fetch", target: "examples.internal", argsHash: OTHER_ARGS_HASH } })],
        recheck: async () => (call++ === 0 ? block : allow),
      },
    );
    expect(result.pass).toBe(false);
    expect(result.checks.find((c) => c.name === "gatewayAfter")?.detail).toContain("1 of 2 still blocked");
  });

  it("ALLOW holds when at least one previously blocked descriptor is allowed now", async () => {
    const result = await evaluate({ outcome: "any", gatewayAfter: "ALLOW" }, { gatewayLog: [line()], recheck: async () => allow });
    expect(result.pass).toBe(true);
    expect(result.rechecks[0]?.detail).toContain('allowed on basis "exception"');
  });

  it("BLOCK holds vacuously when the fleet never attempted the host, and says so", async () => {
    const result = await evaluate({ outcome: "any", gatewayAfter: "BLOCK" });
    expect(result.pass).toBe(true);
    expect(result.checks.find((c) => c.name === "gatewayAfter")?.detail).toContain("never attempted");
  });

  it("ALLOW fails when the fleet was never blocked, since nothing demonstrates a changed verdict", async () => {
    const result = await evaluate({ outcome: "any", gatewayAfter: "ALLOW" });
    expect(result.pass).toBe(false);
    expect(result.checks.find((c) => c.name === "gatewayAfter")?.detail).toContain("never blocked");
  });

  it("a ledger_unreadable re-check is an error, never a satisfied BLOCK expectation", async () => {
    const result = await evaluate({ outcome: "any", gatewayAfter: "BLOCK" }, { gatewayLog: [line()], recheck: async () => unreadable });
    expect(result.pass).toBe(false);
    const check = result.checks.find((c) => c.name === "gatewayAfter");
    expect(check?.detail).toContain("ledger_unreadable");
    expect(check?.detail).toContain("could not evaluate");
    expect(result.rechecks[0]?.unreadable).toBe(true);
  });

  it("a ledger_unreadable re-check fails an ALLOW expectation too", async () => {
    const result = await evaluate({ outcome: "any", gatewayAfter: "ALLOW" }, { gatewayLog: [line()], recheck: async () => unreadable });
    expect(result.pass).toBe(false);
  });

  it("is not evaluated at all when the fixture sets no gatewayAfter", async () => {
    const result = await evaluate({ outcome: "any" }, { gatewayLog: [line()] });
    expect(result.checks.some((c) => c.name === "gatewayAfter")).toBe(false);
    expect(result.rechecks).toEqual([]);
  });
});
