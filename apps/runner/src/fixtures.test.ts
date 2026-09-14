import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_FIXTURE_ORDER, loadDemoFixtures, loadFixture, loadScriptedFixtures } from "./fixtures.js";

const currentDir = path.dirname(new URL(import.meta.url).pathname);
const repoScriptedDir = path.resolve(currentDir, "../../../experiments/fixtures/scripted");

describe("loadFixture / loadScriptedFixtures (the real experiments/fixtures/scripted directory)", () => {
  it("loads and validates every committed scripted fixture", () => {
    const fixtures = loadScriptedFixtures(repoScriptedDir);
    expect(fixtures.length).toBe(8);
    for (const f of fixtures) {
      expect(f.schema).toBe("fleet.fixture.v1");
    }
  });

  it("loads the eight demo fixtures in the brief's fixed order", () => {
    const fixtures = loadDemoFixtures(repoScriptedDir);
    expect(fixtures.map((f) => f.name)).toEqual([...DEMO_FIXTURE_ORDER]);
  });

  it("hf-replay parses with the expected shape from the brief", () => {
    const fixture = loadFixture(path.join(repoScriptedDir, "hf-replay.json"));
    expect(fixture.trigger.agentId).toBe(1);
    expect(fixture.trigger.action?.class).toBe("network_fetch");
    expect(fixture.script["1"]).toBe("FOR");
    expect(fixture.expected).toEqual({ outcome: "Defeated", gatewayAfter: "BLOCK", decisionCount: 0 });
  });
});

describe("loadFixture / loadScriptedFixtures (temp-dir fakes)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-fixtures-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws RunnerEnvError for a missing file", () => {
    expect(() => loadFixture(path.join(dir, "missing.json"))).toThrow(/could not read fixture/);
  });

  it("throws RunnerEnvError for invalid JSON", () => {
    const file = path.join(dir, "bad.json");
    writeFileSync(file, "{ not json");
    expect(() => loadFixture(file)).toThrow(/not valid JSON/);
  });

  it("throws RunnerEnvError for JSON that does not parse as fleet.fixture.v1", () => {
    const file = path.join(dir, "bad-shape.json");
    writeFileSync(file, JSON.stringify({ schema: "fleet.fixture.v1" }));
    expect(() => loadFixture(file)).toThrow(/does not parse as fleet\.fixture\.v1/);
  });

  it("loadScriptedFixtures sorts by filename and ignores non-JSON files", () => {
    writeFileSync(
      path.join(dir, "b-fixture.json"),
      JSON.stringify({
        schema: "fleet.fixture.v1",
        name: "b",
        description: "b",
        trigger: { agentId: 0, kind: "GRANT_EXCEPTION", action: { class: "read_repo", target: "x", args: {} }, summary: "s" },
        script: {},
        expected: { outcome: "Defeated", decisionCount: 0 },
      }),
    );
    writeFileSync(
      path.join(dir, "a-fixture.json"),
      JSON.stringify({
        schema: "fleet.fixture.v1",
        name: "a",
        description: "a",
        trigger: { agentId: 0, kind: "GRANT_EXCEPTION", action: { class: "read_repo", target: "x", args: {} }, summary: "s" },
        script: {},
        expected: { outcome: "Defeated", decisionCount: 0 },
      }),
    );
    writeFileSync(path.join(dir, "notes.txt"), "ignore me");
    const fixtures = loadScriptedFixtures(dir);
    expect(fixtures.map((f) => f.name)).toEqual(["a", "b"]);
  });

  it("loadDemoFixtures throws RunnerEnvError naming a missing demo fixture", () => {
    expect(() => loadDemoFixtures(dir)).toThrow(/demo fixture "hf-replay" not found/);
  });
});
