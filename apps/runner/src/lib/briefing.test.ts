import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBriefing } from "./briefing.js";

let dir: string;

const PROMPTS = ["packages", "agent-runtime", "src", "providers", "prompts"];

function write(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function charter(goal: string) {
  return {
    schema: "fleet.charter.v1" as const,
    goal,
    allowedActionClasses: ["read_repo" as const, "network_fetch" as const],
    forbiddenActions: ["modify_tests"],
    externalAllowlist: ["registry.npmjs.org"],
    budget: { toolCalls: 200, inferenceTokens: 400000 },
    stopConditions: ["test suite passes"],
  };
}

function experiment(roles: string[]) {
  return {
    task: { charter: charter("from the experiment config"), repoFixture: "experiments/fixtures/repos/tiny-lib", lifetime: 1 },
    fleet: {
      members: roles.map((role) => ({ role, provider: "openrouter", model: "m", promptVersion: "1", operatorLabel: "local" })),
      tokenName: "Fleet Vote",
      tokenSymbol: "FLEET",
    },
  } as never;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-briefing-"));
  write(path.join(dir, ...PROMPTS, "constitution.md"), "# Constitution\nVote Against a clear charter violation.\n");
  write(path.join(dir, ...PROMPTS, "role-planner.md"), "# Planner\nFit with the goal.\n");
  write(path.join(dir, ...PROMPTS, "role-budget-reviewer.md"), "# Budget reviewer\nCost and opportunity cost.\n");
  write(path.join(dir, ...PROMPTS, "next-step.md"), "# Choose the next step\n");
  write(path.join(dir, ...PROMPTS, "objection.md"), "# Object, or do not\n");
  write(path.join(dir, ...PROMPTS, "blockresponse.md"), "# Respond to a blocked action\n");
  write(path.join(dir, ...PROMPTS, "evaluate-proposal.md"), "# Vote on this proposal\n");
  write(path.join(dir, "experiments", "fixtures", "repos", "tiny-lib", "README.md"), "Implement the failing functions.\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildBriefing", () => {
  it("assembles the constitution, the role prompts, the charter, and the task readme", () => {
    const b = buildBriefing(dir, "run-1", { experiment: experiment(["planner", "Budget reviewer"]), recordConfig: null });

    expect(b.constitution).toContain("Vote Against a clear charter violation");
    expect(b.charter?.goal).toBe("from the experiment config");
    expect(b.charterSource).toBe("experiment");
    expect(b.taskReadme).toContain("Implement the failing functions");
    expect(b.templates.map((t) => t.file)).toEqual(["next-step.md", "objection.md", "blockresponse.md", "evaluate-proposal.md"]);
  });

  it("maps a role name to its prompt file however it is spelled, and numbers agents from zero", () => {
    const b = buildBriefing(dir, "run-1", { experiment: experiment(["planner", "Budget reviewer"]), recordConfig: null });

    expect(b.roles.map((r) => [r.agentId, r.promptFile])).toEqual([
      [0, "role-planner.md"],
      [1, "role-budget-reviewer.md"],
    ]);
    expect(b.roles[1]?.prompt).toContain("Cost and opportunity cost");
  });

  it("prefers the run's own record over the experiment config, since the record is what the run used", () => {
    const recordConfig = { task: { charter: charter("from the record"), repoFixture: "experiments/fixtures/repos/tiny-lib" } };
    const b = buildBriefing(dir, "run-1", { experiment: experiment(["planner"]), recordConfig });

    expect(b.charter?.goal).toBe("from the record");
    expect(b.charterSource).toBe("record");
  });

  it("reports a missing role prompt as absent rather than failing the page", () => {
    const b = buildBriefing(dir, "run-1", { experiment: experiment(["ombudsman"]), recordConfig: null });

    expect(b.roles[0]?.prompt).toBeNull();
    expect(b.roles[0]?.promptFile).toBe("role-ombudsman.md");
  });

  it("returns no charter and no roles when there is neither a record nor an experiment config", () => {
    const b = buildBriefing(dir, "run-1", { experiment: null, recordConfig: null });

    expect(b.charter).toBeNull();
    expect(b.charterSource).toBe("none");
    expect(b.roles).toEqual([]);
    expect(b.constitution).toContain("Constitution");
  });
});
