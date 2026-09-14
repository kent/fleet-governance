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

  it("rejects an absolute charter path with the escape error, never reading it", () => {
    const outsideAbsolutePath = path.join(tmpdir(), "fleet-fixtures-route-outside-secret.json");
    writeJson(outsideAbsolutePath, {
      schema: "fleet.charter.v1",
      goal: "This charter lives outside the repo root and must never be read.",
      allowedActionClasses: [],
      forbiddenActions: [],
      externalAllowlist: [],
      budget: { toolCalls: 1, inferenceTokens: 1 },
      stopConditions: [],
    });
    writeJson(
      path.join(repoRootDir, "experiments", "fixtures", "model", "model-absolute.json"),
      modelFixture("model-absolute", outsideAbsolutePath),
    );

    try {
      const fixtures = listAllFixtures(repoRootDir);
      const summary = fixtures.find((f) => f.name === "model-absolute");
      expect(summary?.charter).toBeUndefined();
      expect(summary?.charterError).toBe("charter path escapes the repository root");
      expect(summary?.charterError).not.toContain(outsideAbsolutePath);
      expect(summary?.charterError).not.toContain(repoRootDir);
    } finally {
      rmSync(outsideAbsolutePath, { force: true });
    }
  });

  it("rejects a charter path that escapes the repo root with '..', never reading it", () => {
    const escapedPath = path.join(path.dirname(repoRootDir), "fleet-fixtures-route-escaped-charter.json");
    writeJson(escapedPath, {
      schema: "fleet.charter.v1",
      goal: "This charter lives one directory above the repo root and must never be read.",
      allowedActionClasses: [],
      forbiddenActions: [],
      externalAllowlist: [],
      budget: { toolCalls: 1, inferenceTokens: 1 },
      stopConditions: [],
    });
    writeJson(
      path.join(repoRootDir, "experiments", "fixtures", "model", "model-traversal.json"),
      modelFixture("model-traversal", "../fleet-fixtures-route-escaped-charter.json"),
    );

    try {
      const fixtures = listAllFixtures(repoRootDir);
      const summary = fixtures.find((f) => f.name === "model-traversal");
      expect(summary?.charter).toBeUndefined();
      expect(summary?.charterError).toBe("charter path escapes the repository root");
    } finally {
      rmSync(escapedPath, { force: true });
    }
  });

  it("still resolves a normal nested charter path inside the repo root", () => {
    writeJson(
      path.join(repoRootDir, "experiments", "fixtures", "model", "model-nested.json"),
      modelFixture("model-nested", "experiments/fixtures/charters/nested/sub/deep.json"),
    );
    writeJson(path.join(repoRootDir, "experiments", "fixtures", "charters", "nested", "sub", "deep.json"), {
      schema: "fleet.charter.v1",
      goal: "A validly nested charter, well inside the repo root.",
      allowedActionClasses: [],
      forbiddenActions: [],
      externalAllowlist: [],
      budget: { toolCalls: 1, inferenceTokens: 1 },
      stopConditions: [],
    });

    const fixtures = listAllFixtures(repoRootDir);
    const summary = fixtures.find((f) => f.name === "model-nested");
    expect(summary?.charterError).toBeUndefined();
    expect(summary?.charter?.goal).toBe("A validly nested charter, well inside the repo root.");
  });
});
