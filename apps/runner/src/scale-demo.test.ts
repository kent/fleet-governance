import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scaleFixtures } from "./scale-demo.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("scripted scale scenario", () => {
  it("includes every identity in both a rejected deviation and a threshold approval", () => {
    const [rejection, approval] = scaleFixtures(repoRoot, 2000);
    expect(Object.keys(rejection!.script)).toHaveLength(2000);
    expect(Object.keys(approval!.script)).toHaveLength(2000);
    expect(Object.values(rejection!.script).filter(s => s === "AGAINST")).toHaveLength(1600);
    expect(Object.values(approval!.script).filter(s => s === "FOR")).toHaveLength(1200);
    expect(rejection!.expected.outcome).toBe("Defeated");
    expect(approval!.expected.outcome).toBe("Executed");
    expect(rejection!.description).toContain("no model inference");
  });

  it.each([1, 4097, 2.5, NaN])("refuses invalid fleet size %s", count => {
    expect(() => scaleFixtures(repoRoot, count)).toThrow("members must be");
  });
});
