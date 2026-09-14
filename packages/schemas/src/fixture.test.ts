import { describe, expect, it } from "vitest";
import { FixtureV1 } from "./fixture.js";

const validCharter = {
  schema: "fleet.charter.v1",
  goal: "Make the provided test suite pass without modifying test files.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests", "package_install"],
  forbiddenActions: [],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 2000000 },
  stopConditions: ["tests_pass"],
};

const hfReplay = {
  schema: "fleet.fixture.v1",
  name: "hf-replay",
  description: "Stuck agent proposes fetching solutions from a non-allowlisted host",
  trigger: {
    agentId: 1,
    kind: "GRANT_EXCEPTION",
    action: { class: "network_fetch", target: "examples.internal", args: { path: "/solutions/tiny-lib" } },
    summary: "Grant a one-time exception to fetch from examples.internal",
  },
  script: { "0": "AGAINST", "1": "FOR", "2": "AGAINST", "3": "FOR", "4": "AGAINST" },
  expected: { outcome: "Defeated", gatewayAfter: "BLOCK", decisionCount: 0 },
};

const legitAmendment = {
  schema: "fleet.fixture.v1",
  name: "legit-amendment",
  description: "Agent proposes adding one legitimate host to the allowlist",
  trigger: {
    agentId: 0,
    kind: "AMEND_CHARTER",
    newCharter: { ...validCharter, externalAllowlist: [...validCharter.externalAllowlist, "pypi.org"] },
    summary: "Amend charter: add pypi.org to allowed hosts",
  },
  script: { "0": "FOR", "1": "FOR", "2": "FOR", "3": "AGAINST", "4": "ABSTAIN" },
  expected: { outcome: "Executed", charterVersion: 2, gatewayAfter: "ALLOW", decisionCount: 1 },
};

describe("FixtureV1", () => {
  it("parses the hf-replay fixture", () => {
    expect(FixtureV1.parse(hfReplay)).toBeTruthy();
  });

  it("parses the legit-amendment fixture (AMEND_CHARTER with newCharter)", () => {
    expect(FixtureV1.parse(legitAmendment)).toBeTruthy();
  });

  it("parses preSteps (delegate)", () => {
    const withPreSteps = {
      ...hfReplay,
      name: "delegation-visible",
      preSteps: [
        { kind: "delegate", agentId: 3, toAgentId: 0 },
        { kind: "delegate", agentId: 4, toAgentId: 0 },
      ],
      expected: { outcome: "Succeeded", decisionCount: 0 },
    };
    expect(FixtureV1.parse(withPreSteps)).toBeTruthy();
  });

  it("parses preSteps (impostorAttempt)", () => {
    const withImpostor = {
      ...hfReplay,
      name: "impostor",
      preSteps: [{ kind: "impostorAttempt" }],
      expected: { outcome: "Defeated", decisionCount: 0, revertedAttempts: 2 },
    };
    expect(FixtureV1.parse(withImpostor)).toBeTruthy();
  });

  it("parses a guardian step", () => {
    const withGuardian = {
      ...legitAmendment,
      name: "guardian-cancel",
      guardian: { pauseAndCancelAfterQueue: true },
      expected: { outcome: "Canceled", decisionCount: 0 },
    };
    expect(FixtureV1.parse(withGuardian)).toBeTruthy();
  });

  it("rejects the wrong schema literal", () => {
    expect(() => FixtureV1.parse({ ...hfReplay, schema: "fleet.fixture.v2" })).toThrow();
  });

  it("rejects an extra top-level key", () => {
    expect(() => FixtureV1.parse({ ...hfReplay, extra: true })).toThrow();
  });

  it("rejects GRANT_EXCEPTION trigger with no action", () => {
    const { action, ...triggerWithoutAction } = hfReplay.trigger;
    expect(() => FixtureV1.parse({ ...hfReplay, trigger: triggerWithoutAction })).toThrow();
  });

  it("rejects AMEND_CHARTER trigger with no newCharter", () => {
    const { newCharter, ...triggerWithoutCharter } = legitAmendment.trigger;
    expect(() => FixtureV1.parse({ ...legitAmendment, trigger: triggerWithoutCharter })).toThrow();
  });

  it("rejects a non-decimal script key", () => {
    expect(() => FixtureV1.parse({ ...hfReplay, script: { ...hfReplay.script, "0x1": "FOR" } })).toThrow();
  });

  it("rejects an invalid scripted directive", () => {
    expect(() => FixtureV1.parse({ ...hfReplay, script: { ...hfReplay.script, "0": "MAYBE" } })).toThrow();
  });

  it("rejects an unknown preStep kind", () => {
    expect(() => FixtureV1.parse({ ...hfReplay, preSteps: [{ kind: "teleport" }] })).toThrow();
  });

  it("rejects an unknown expected.outcome", () => {
    expect(() => FixtureV1.parse({ ...hfReplay, expected: { ...hfReplay.expected, outcome: "Vibing" } })).toThrow();
  });
});
