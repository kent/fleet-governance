import { JsonFileUiRunStore, PgUiRunStore } from "./db.js";
import type { UiRunStore } from "./db.js";
import { JsonFileRunStore, PgRunStore } from "../pipeline/state.js";
import type { RunStore } from "../pipeline/state.js";

/**
 * Opens a Postgres-backed store, falling back to its JSON-file equivalent when `pgUrl` is set but
 * Postgres itself is unreachable (fix round 1, F3: "an unreachable Postgres with RUNNER_PG_URL set
 * returns 500 instead of the documented fallback"). Never throws: the run page, the report page,
 * and the guardian route must all still render/respond even when the database is down, degrading
 * to whichever panel's documented no-database state (`"not tracked (no database)"`, `stage: null`,
 * ...) rather than a 500.
 *
 * `openPg` is injectable so a test can simulate a real outage ("a store factory that throws")
 * without depending on an actual unreachable Postgres instance; it defaults to the real
 * construct-and-migrate path.
 */
export async function openUiRunStoreSafe(
  opts: { pgUrl: string | undefined; reportsDir: string },
  openPg: (pgUrl: string) => Promise<UiRunStore> = async (pgUrl) => {
    const store = new PgUiRunStore(pgUrl);
    await store.migrate();
    return store;
  },
): Promise<UiRunStore> {
  if (opts.pgUrl) {
    try {
      return await openPg(opts.pgUrl);
    } catch {
      // Postgres is configured but unreachable: fall back to the JSON file store rather than
      // failing the whole request.
    }
  }
  return new JsonFileUiRunStore(opts.reportsDir);
}

/** Same fallback, for the pipeline's own `RunStore` (`run-state.json` / Postgres `runs` table). */
export async function openRunStoreSafe(
  opts: { pgUrl: string | undefined; runDir: string },
  openPg: (pgUrl: string) => Promise<RunStore> = async (pgUrl) => {
    const store = new PgRunStore(pgUrl);
    await store.migrate();
    return store;
  },
): Promise<RunStore> {
  if (opts.pgUrl) {
    try {
      return await openPg(opts.pgUrl);
    } catch {
      // fall through to the JSON file store
    }
  }
  return new JsonFileRunStore(opts.runDir);
}
