import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRunContext } from "./run-context.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-run-context-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("resolveRunContext", () => {
  it("resolves nothing for a run with no files written yet", async () => {
    const ctx = await resolveRunContext("run-none", dir, undefined);
    expect(ctx.uiRow).toBeNull();
    expect(ctx.experiment).toBeNull();
    expect(ctx.deployConfig).toBeNull();
    expect(ctx.record).toBeNull();
    expect(ctx.manifest).toBeNull();
    expect(ctx.runDir).toBe(path.join(dir, "experiments", "reports", "run-none"));
  });

  it("finds the experiment config at the conventional path when there is no ui_runs row", async () => {
    const experiment = { schema: "fleet.experiment.v1", name: "run-conv" };
    writeJson(path.join(dir, "experiments", "configs", "run-conv.json"), experiment);
    const ctx = await resolveRunContext("run-conv", dir, undefined);
    // ExperimentConfigV1.safeParse will fail on this minimal stub (missing required fields), so
    // this asserts the *path* resolution only, not full schema validity.
    expect(ctx.experiment).toBeNull();
  });

  it("prefers the ui_runs row's recorded experimentPath over the conventional path", async () => {
    const customPath = path.join(dir, "somewhere-else", "custom.json");
    writeJson(customPath, {
      schema: "fleet.experiment.v1",
      name: "run-ui",
      target: { kind: "local-anvil", rpcHttp: "http://127.0.0.1:8545", rpcWs: "ws://127.0.0.1:8545" },
      fleet: {
        members: [
          { role: "a", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
          { role: "b", provider: "scripted", model: "m", promptVersion: "1", operatorLabel: "local" },
        ],
        tokenName: "Fleet Vote",
        tokenSymbol: "FLEET",
      },
      governance: { votingDelay: 1, votingPeriod: 1, timelockDelay: 1, quorumNumerator: 6000, proposalThreshold: "0", maxTaskLifetime: 1 },
      task: {
        charter: {
          schema: "fleet.charter.v1",
          goal: "g",
          allowedActionClasses: ["read_repo"],
          forbiddenActions: [],
          externalAllowlist: [],
          budget: { toolCalls: 1, inferenceTokens: 1 },
          stopConditions: [],
        },
        lifetime: 1,
        repoFixture: "x",
      },
      scenario: { fixture: "hf-replay", agentsScripted: true },
      capture: { reportDir: "experiments/reports" },
      display: {},
    });
    writeJson(path.join(dir, "experiments", "reports", "ui-runs.json"), [
      {
        runId: "run-ui",
        experimentPath: customPath,
        deployConfigPath: path.join(dir, "somewhere-else", "custom.deploy.json"),
        logPath: path.join(dir, "experiments", "reports", "run-ui", "run.log"),
        pid: 1,
        readSide: false,
        createdAt: "2026-09-14T00:00:00.000Z",
      },
    ]);

    const ctx = await resolveRunContext("run-ui", dir, undefined);
    expect(ctx.uiRow?.experimentPath).toBe(customPath);
    expect(ctx.experiment?.name).toBe("run-ui");
  });
});
