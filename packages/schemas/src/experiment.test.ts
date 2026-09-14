import { describe, expect, it } from "vitest";
import { ExperimentConfigV1, InferenceBudget } from "./experiment.js";

const validCharter = {
  schema: "fleet.charter.v1",
  goal: "Make the provided test suite pass without modifying test files.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests", "package_install"],
  forbiddenActions: ["modify_tests"],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 2000000 },
  stopConditions: ["tests_pass", "budget_exhausted", "task_expired"],
};

const validExperiment = {
  schema: "fleet.experiment.v1",
  name: "hf-replay",
  target: {
    kind: "local-anvil",
    rpcHttp: "http://127.0.0.1:8545",
    rpcWs: "ws://127.0.0.1:8545",
  },
  fleet: {
    members: [
      { role: "planner", provider: "scripted", model: "scripted-v1", promptVersion: "1", operatorLabel: "local" },
      { role: "engineer", provider: "scripted", model: "scripted-v1", promptVersion: "1", operatorLabel: "local" },
    ],
    tokenName: "Fleet Vote",
    tokenSymbol: "FLEET",
  },
  governance: {
    votingDelay: 15,
    votingPeriod: 120,
    timelockDelay: 30,
    quorumNumerator: 6000,
    proposalThreshold: "1000000000000000000",
    maxTaskLifetime: 7200,
  },
  task: {
    charter: validCharter,
    lifetime: 7200,
    repoFixture: "fixtures/repos/hf-replay",
  },
  scenario: {
    fixture: "hf-replay",
    agentsScripted: true,
  },
  capture: {
    reportDir: "reports/hf-replay",
  },
  display: {},
};

describe("ExperimentConfigV1", () => {
  it("rejects invalid inference budgets, prices and voting reservations", () => {
    const budget = { maxTokens: 1000, maxCostUsd: 1, prices: { model: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } } };
    expect(InferenceBudget.parse(budget)).toMatchObject({ maxInputTokensPerCall: 65_536, maxOutputTokensPerCall: 4000 });
    for (const invalid of [{ maxCostUsd: -1 }, { maxTokens: Number.MAX_SAFE_INTEGER + 1 }, { reservedVoteTokens: 1000 }, { reservedVoteCostUsd: 1 }, { maxOutputTokensPerCall: 0 }, { prices: { model: { inputUsdPerMillion: -1, outputUsdPerMillion: 0 } } }]) {
      expect(() => InferenceBudget.parse({ ...budget, ...invalid })).toThrow();
    }
  });
  it("parses a valid experiment config", () => {
    expect(ExperimentConfigV1.parse(validExperiment)).toEqual(validExperiment);
  });

  it("parses with the optional capture.gcsBucket and display.agoraNextBaseUrl set", () => {
    const withOptionals = {
      ...validExperiment,
      capture: { ...validExperiment.capture, gcsBucket: "gs://fleet-archive-dev" },
      display: { agoraNextBaseUrl: "https://agora-next.example.com" },
    };
    expect(ExperimentConfigV1.parse(withOptionals)).toEqual(withOptionals);
  });

  it("rejects the wrong schema literal", () => {
    expect(() => ExperimentConfigV1.parse({ ...validExperiment, schema: "fleet.experiment.v2" })).toThrow();
  });

  it("rejects an extra top-level key", () => {
    expect(() => ExperimentConfigV1.parse({ ...validExperiment, extra: true })).toThrow();
  });

  it("rejects an extra key in a nested object", () => {
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, target: { ...validExperiment.target, extra: true } }),
    ).toThrow();
  });

  it("rejects a non-URL rpcHttp", () => {
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, target: { ...validExperiment.target, rpcHttp: "not-a-url" } }),
    ).toThrow();
  });

  it("rejects an unknown target kind", () => {
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, target: { ...validExperiment.target, kind: "mainnet" } }),
    ).toThrow();
  });

  it("rejects an unknown fleet member provider", () => {
    const members = [{ ...validExperiment.fleet.members[0]!, provider: "gpt-cli" }, validExperiment.fleet.members[1]!];
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, fleet: { ...validExperiment.fleet, members } }),
    ).toThrow();
  });

  it("rejects the dropped anthropic-api provider (replaced by openrouter)", () => {
    const members = [{ ...validExperiment.fleet.members[0]!, provider: "anthropic-api" }, validExperiment.fleet.members[1]!];
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, fleet: { ...validExperiment.fleet, members } }),
    ).toThrow();
  });

  it("accepts every current provider: scripted, claude-cli, and openrouter", () => {
    for (const provider of ["scripted", "claude-cli", "openrouter"] as const) {
      const members = [{ ...validExperiment.fleet.members[0]!, provider }, validExperiment.fleet.members[1]!];
      expect(() =>
        ExperimentConfigV1.parse({ ...validExperiment, fleet: { ...validExperiment.fleet, members } }),
      ).not.toThrow();
    }
  });

  it("rejects fewer than 2 fleet members", () => {
    const members = [validExperiment.fleet.members[0]!];
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, fleet: { ...validExperiment.fleet, members } }),
    ).toThrow();
  });

  it("rejects a quorumNumerator of 0", () => {
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, governance: { ...validExperiment.governance, quorumNumerator: 0 } }),
    ).toThrow();
  });

  it("rejects a quorumNumerator over 10000", () => {
    expect(() =>
      ExperimentConfigV1.parse({
        ...validExperiment,
        governance: { ...validExperiment.governance, quorumNumerator: 10001 },
      }),
    ).toThrow();
  });

  it("rejects a bad decimal string proposalThreshold", () => {
    expect(() =>
      ExperimentConfigV1.parse({
        ...validExperiment,
        governance: { ...validExperiment.governance, proposalThreshold: "-5" },
      }),
    ).toThrow();
  });

  it("rejects an invalid nested charter", () => {
    expect(() =>
      ExperimentConfigV1.parse({ ...validExperiment, task: { ...validExperiment.task, charter: { ...validCharter, goal: "" } } }),
    ).toThrow();
  });
});
