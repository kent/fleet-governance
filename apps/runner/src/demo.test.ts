import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { FixtureRunResult } from "./pipeline/fixture-runner.js";
import { DEMO_TASK_CHARTER, formatDemoTable } from "./demo.js";

const currentDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(currentDir, "../../..");

function fakeResult(overrides: Partial<Pick<FixtureRunResult, "fixture" | "finalStateName" | "pass" | "mismatches">>): Pick<
  FixtureRunResult,
  "fixture" | "finalStateName" | "pass" | "mismatches"
> {
  return {
    fixture: { name: "hf-replay", expected: { outcome: "Defeated", decisionCount: 0 } } as FixtureRunResult["fixture"],
    finalStateName: "Defeated",
    pass: true,
    mismatches: [],
    ...overrides,
  };
}

describe("DEMO_TASK_CHARTER", () => {
  it("matches legit-amendment.json's newCharter exactly, apart from the one appended allowlist host", () => {
    const legitAmendment = JSON.parse(
      readFileSync(path.join(repoRoot, "experiments", "fixtures", "scripted", "legit-amendment.json"), "utf8"),
    );
    const newCharter = legitAmendment.trigger.newCharter;
    expect(newCharter.externalAllowlist.slice(0, -1)).toEqual(DEMO_TASK_CHARTER.externalAllowlist);
    const { externalAllowlist: _newAllowlist, ...restOfNewCharter } = newCharter;
    const { externalAllowlist: _baseAllowlist, ...restOfBaseCharter } = DEMO_TASK_CHARTER;
    expect(restOfNewCharter).toEqual(restOfBaseCharter);
  });
});

describe("formatDemoTable", () => {
  it("renders a header and one row per result", () => {
    const table = formatDemoTable([
      fakeResult({ fixture: { name: "hf-replay", expected: { outcome: "Defeated", decisionCount: 0 } } as never }),
      fakeResult({ fixture: { name: "legit-amendment", expected: { outcome: "Executed", decisionCount: 1 } } as never, finalStateName: "Executed" }),
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("FIXTURE");
    expect(lines[0]).toContain("EXPECTED");
    expect(lines[0]).toContain("ACTUAL");
    expect(lines[0]).toContain("STATUS");
    expect(table).toContain("hf-replay");
    expect(table).toContain("legit-amendment");
    expect(table).toContain("PASS");
  });

  it("shows FAIL and lists mismatches for a failed fixture", () => {
    const table = formatDemoTable([
      fakeResult({ pass: false, mismatches: ["outcome: expected Defeated, got Succeeded"], finalStateName: "Succeeded" }),
    ]);
    expect(table).toContain("FAIL");
    expect(table).toContain("outcome: expected Defeated, got Succeeded");
  });

  it("pads columns to the widest value so the table stays aligned", () => {
    const table = formatDemoTable([
      fakeResult({ fixture: { name: "a-very-long-fixture-name", expected: { outcome: "Defeated", decisionCount: 0 } } as never }),
      fakeResult({ fixture: { name: "x", expected: { outcome: "Defeated", decisionCount: 0 } } as never }),
    ]);
    const lines = table.split("\n").filter((l) => l.startsWith("a-very-long") || l.startsWith("x "));
    expect(lines.length).toBe(2);
    // Both rows carry the same trailing "Defeated  Defeated  PASS" content, just under a
    // different-width first column; if padding is consistent the two rendered lines are the same
    // total length.
    expect(lines[0]!.length).toBe(lines[1]!.length);
  });
});
