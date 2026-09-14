import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertScenarioMatchesFixture, fixtureKind, isModelFixture, resolveFixture } from "./fixture-resolve.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const committedFixturesRoot = path.join(repoRoot, "experiments", "fixtures");

describe("resolveFixture against the committed fixtures", () => {
  it("finds a scripted fixture under scripted/", () => {
    const { fixture, filePath } = resolveFixture(committedFixturesRoot, "guardian-cancel");
    expect(fixture.schema).toBe("fleet.fixture.v1");
    expect(fixtureKind(fixture)).toBe("scripted");
    expect(filePath.endsWith(path.join("scripted", "guardian-cancel.json"))).toBe(true);
  });

  it("finds a model fixture under model/, with its hosts, charter path and rubric", () => {
    const { fixture, filePath } = resolveFixture(committedFixturesRoot, "coordinator-overreach");
    expect(fixture.schema).toBe("fleet.fixture.model.v1");
    expect(fixtureKind(fixture)).toBe("model");
    expect(filePath.endsWith(path.join("model", "coordinator-overreach.json"))).toBe(true);
    if (!isModelFixture(fixture)) throw new Error("expected a model fixture");
    expect(fixture.charter).toBe("experiments/fixtures/charters/coding-task.v1.json");
    expect(fixture.hosts.map((h) => h.name)).toEqual(["examples.internal"]);
    expect(fixture.rubric.length).toBeGreaterThan(0);
    expect(fixture.coordinatorRole).toBe("planner");
  });

  it("prefers the scripted variant by default for a name that exists in both directories", () => {
    const { fixture } = resolveFixture(committedFixturesRoot, "hf-replay");
    expect(fixture.schema).toBe("fleet.fixture.v1");
  });

  it("resolves the model variant of a doubly-named fixture when the caller prefers model", () => {
    for (const name of ["hf-replay", "legit-amendment"]) {
      const scripted = resolveFixture(committedFixturesRoot, name, { prefer: "scripted" });
      const model = resolveFixture(committedFixturesRoot, name, { prefer: "model" });
      expect(scripted.fixture.schema).toBe("fleet.fixture.v1");
      expect(model.fixture.schema).toBe("fleet.fixture.model.v1");
      expect(model.filePath).not.toBe(scripted.filePath);
    }
  });

  it("ignores prefer when the name exists in only one directory", () => {
    expect(resolveFixture(committedFixturesRoot, "guardian-cancel", { prefer: "model" }).fixture.schema).toBe("fleet.fixture.v1");
    expect(resolveFixture(committedFixturesRoot, "escalate", { prefer: "scripted" }).fixture.schema).toBe("fleet.fixture.model.v1");
  });
});

describe("resolveFixture failures", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-fixture-resolve-"));
    mkdirSync(path.join(dir, "scripted"), { recursive: true });
    mkdirSync(path.join(dir, "model"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names both paths it looked in when the fixture does not exist", () => {
    expect(() => resolveFixture(dir, "nope")).toThrow(/scripted\/nope\.json and .*model\/nope\.json/);
  });

  it("names the file when it is not valid JSON", () => {
    writeFileSync(path.join(dir, "model", "broken.json"), "{not json", "utf8");
    expect(() => resolveFixture(dir, "broken")).toThrow(/is not valid JSON/);
  });

  it("names the file when its schema literal is not a fixture schema", () => {
    writeFileSync(path.join(dir, "scripted", "odd.json"), JSON.stringify({ schema: "fleet.charter.v1" }), "utf8");
    expect(() => resolveFixture(dir, "odd")).toThrow(/does not parse as a fleet fixture/);
  });

  it("reads a file by its own schema, not by the directory it sits in", () => {
    const modelFixture = {
      schema: "fleet.fixture.model.v1",
      name: "misfiled",
      description: "a model fixture stored under scripted/",
      agentsScripted: false,
      trigger: null,
      charter: "experiments/fixtures/charters/coding-task.v1.json",
      repoFixture: "experiments/fixtures/repos/tiny-lib",
      hosts: [],
      maxSteps: 5,
      expected: { outcome: "any" },
      rubric: ["something"],
    };
    writeFileSync(path.join(dir, "scripted", "misfiled.json"), JSON.stringify(modelFixture), "utf8");
    expect(fixtureKind(resolveFixture(dir, "misfiled").fixture)).toBe("model");
  });
});

describe("assertScenarioMatchesFixture", () => {
  const scripted = resolveFixture(committedFixturesRoot, "guardian-cancel").fixture;
  const model = resolveFixture(committedFixturesRoot, "coordinator-overreach").fixture;

  it("accepts a scripted fixture with agentsScripted true and a model fixture with it false", () => {
    expect(() => assertScenarioMatchesFixture(scripted, true, "guardian-cancel")).not.toThrow();
    expect(() => assertScenarioMatchesFixture(model, false, "coordinator-overreach")).not.toThrow();
  });

  it("rejects a model fixture claimed as scripted, naming both sides of the disagreement", () => {
    expect(() => assertScenarioMatchesFixture(model, true, "coordinator-overreach")).toThrow(
      /is a model fixture .*scenario\.agentsScripted is true/,
    );
  });

  it("rejects a scripted fixture claimed as model", () => {
    expect(() => assertScenarioMatchesFixture(scripted, false, "guardian-cancel")).toThrow(
      /is a scripted fixture .*scenario\.agentsScripted is false/,
    );
  });
});
