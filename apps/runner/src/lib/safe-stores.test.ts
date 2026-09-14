import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonFileRunStore } from "../pipeline/state.js";
import { JsonFileUiRunStore } from "./db.js";
import { openRunStoreSafe, openUiRunStoreSafe } from "./safe-stores.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-safe-stores-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openUiRunStoreSafe", () => {
  it("uses the JSON file store when no RUNNER_PG_URL is set", async () => {
    const store = await openUiRunStoreSafe({ pgUrl: undefined, reportsDir: dir });
    expect(store).toBeInstanceOf(JsonFileUiRunStore);
  });

  it("falls back to the JSON file store when Postgres is unreachable, instead of throwing", async () => {
    const throwingOpenPg = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    };
    const store = await openUiRunStoreSafe({ pgUrl: "postgres://unreachable", reportsDir: dir }, throwingOpenPg);
    expect(store).toBeInstanceOf(JsonFileUiRunStore);
    // The fallback store is fully usable, not a stub.
    await store.insert({
      runId: "run-1",
      experimentPath: "x",
      deployConfigPath: "y",
      logPath: "z",
      pid: 1,
      readSide: false,
      createdAt: "2026-09-14T00:00:00.000Z",
    });
    expect(await store.list()).toHaveLength(1);
  });

  it("uses the injected Postgres store when it opens successfully", async () => {
    const fakeStore = { insert: async () => {}, list: async () => [] };
    const store = await openUiRunStoreSafe({ pgUrl: "postgres://reachable", reportsDir: dir }, async () => fakeStore);
    expect(store).toBe(fakeStore);
  });
});

describe("openRunStoreSafe", () => {
  it("uses the JSON file store when no RUNNER_PG_URL is set", async () => {
    const store = await openRunStoreSafe({ pgUrl: undefined, runDir: dir });
    expect(store).toBeInstanceOf(JsonFileRunStore);
  });

  it("falls back to the JSON file store when Postgres is unreachable", async () => {
    const throwingOpenPg = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    };
    const store = await openRunStoreSafe({ pgUrl: "postgres://unreachable", runDir: dir }, throwingOpenPg);
    expect(store).toBeInstanceOf(JsonFileRunStore);
    expect(await store.get("run-1")).toBeNull();
  });
});
