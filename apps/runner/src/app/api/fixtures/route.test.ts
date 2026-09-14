import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAllFixtures } from "../../../lib/fixtures-handler.js";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

const SCRIPTED_FIXTURE = {
  schema: "fleet.fixture.v1",
  name: "scripted-a",
  description: "A scripted fixture, to confirm it never carries a charter of its own.",
  trigger: { agentId: 0, kind: "STOP_TASK", summary: "stop the task" },
  script: { "0": "FOR" },
  expected: { outcome: "Executed", decisionCount: 1 },
};

function modelFixture(name: string, charterRelativePath: string) {
  return {
    schema: "fleet.fixture.model.v1",
    name,
    description: `Model fixture ${name}`,
    agentsScripted: false,
    trigger: null,
    charter: charterRelativePath,
    repoFixture: "experiments/fixtures/repos/tiny-lib",
    hosts: [],
    coordinatorRole: "planner",
    maxSteps: 10,
    expected: { outcome: "any" },
    rubric: ["at least one rubric line"],
  };
}

describe("GET /api/fixtures (listAllFixtures)", () => {
  let repoRootDir: string;

  beforeEach(() => {
    repoRootDir = mkdtempSync(path.join(tmpdir(), "fleet-fixtures-route-"));
  });

  afterEach(() => {
    rmSync(repoRootDir, { recursive: true, force: true });
  });

  it("gives each model fixture its own parsed charter, not a shared default", () => {
    writeJson(path.join(repoRootDir, "experiments", "fixtures", "scripted", "scripted-a.json"), SCRIPTED_FIXTURE);
    writeJson(path.join(repoRootDir, "experiments", "fixtures", "model", "model-a.json"), modelFixture("model-a", "experiments/fixtures/charters/a.json"));
    writeJson(path.join(repoRootDir, "experiments", "fixtures", "model", "model-b.json"), modelFixture("model-b", "experiments/fixtures/charters/b.json"));
    writeJson(path.join(repoRootDir, "experiments", "fixtures", "charters", "a.json"), {
      schema: "fleet.charter.v1",
      goal: "Charter A's own goal text, distinct from charter B.",
      allowedActionClasses: ["read_repo"],
      forbiddenActions: [],
      externalAllowlist: [],
      budget: { toolCalls: 10, inferenceTokens: 1000 },
      stopConditions: ["test suite passes"],
    });
    writeJson(path.join(repoRootDir, "experiments", "fixtures", "charters", "b.json"), {
      schema: "fleet.charter.v1",
      goal: "Charter B's own goal text, distinct from charter A.",
      allowedActionClasses: ["read_repo", "network_fetch"],
      forbiddenActions: ["shell"],
      externalAllowlist: ["registry.npmjs.org"],
      budget: { toolCalls: 20, inferenceTokens: 2000 },
      stopConditions: ["budget exhausted"],
    });

    const fixtures = listAllFixtures(repoRootDir);

    const scripted = fixtures.find((f) => f.name === "scripted-a");
    expect(scripted?.kind).toBe("scripted");
    expect(scripted?.charter).toBeUndefined();
    expect(scripted?.charterPath).toBeUndefined();

    const modelA = fixtures.find((f) => f.name === "model-a");
    const modelB = fixtures.find((f) => f.name === "model-b");
    expect(modelA?.charter?.goal).toBe("Charter A's own goal text, distinct from charter B.");
    expect(modelB?.charter?.goal).toBe("Charter B's own goal text, distinct from charter A.");
    expect(modelA?.charter?.goal).not.toBe(modelB?.charter?.goal);
    expect(modelA?.charterError).toBeUndefined();
    expect(modelB?.charterError).toBeUndefined();
  });

  it("reports charterError and no charter when a model fixture's charter file is missing", () => {
    writeJson(
      path.join(repoRootDir, "experiments", "fixtures", "model", "model-broken.json"),
      modelFixture("model-broken", "experiments/fixtures/charters/does-not-exist.json"),
    );

    const fixtures = listAllFixtures(repoRootDir);
    const broken = fixtures.find((f) => f.name === "model-broken");
    expect(broken?.charter).toBeUndefined();
    expect(broken?.charterError).toBeTruthy();
    expect(broken?.charterError).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });
});
