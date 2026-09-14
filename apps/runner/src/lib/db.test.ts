import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileUiRunStore } from "./db.js";
import type { UiRunRow } from "./db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-ui-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(runId: string, createdAt: string): UiRunRow {
  return {
    runId,
    experimentPath: `experiments/configs/${runId}.json`,
    deployConfigPath: `deployments/configs/${runId}.deploy.json`,
    logPath: `experiments/reports/${runId}/run.log`,
    pid: 1234,
    readSide: false,
    createdAt,
  };
}

describe("JsonFileUiRunStore", () => {
  it("lists no rows before anything is inserted", async () => {
    const store = new JsonFileUiRunStore(dir);
    expect(await store.list()).toEqual([]);
  });

  it("lists inserted rows newest first", async () => {
    const store = new JsonFileUiRunStore(dir);
    await store.insert(row("run-a", "2026-09-14T00:00:00.000Z"));
    await store.insert(row("run-b", "2026-09-14T00:01:00.000Z"));
    await store.insert(row("run-c", "2026-09-14T00:02:00.000Z"));

    const rows = await store.list();
    expect(rows.map((r) => r.runId)).toEqual(["run-c", "run-b", "run-a"]);
  });
});
