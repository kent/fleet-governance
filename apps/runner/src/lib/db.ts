import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * The Runner UI's own index of runs it started, one row per `POST /api/runs` call (controller
 * notes item 6). Distinct from the pipeline's own `runs` table / `run-state.json` (`state.ts`):
 * this only records what the UI wrote and spawned; Task 6 reads stage progress from the
 * pipeline's own store, not from here.
 */
export type UiRunRow = {
  runId: string;
  experimentPath: string;
  deployConfigPath: string;
  logPath: string;
  pid: number;
  readSide: boolean;
  createdAt: string;
};

export interface UiRunStore {
  insert(row: UiRunRow): Promise<void>;
}

/** JSON-file `UiRunStore`: one `ui-runs.json` array under `experiments/reports/`. Used whenever
 *  `RUNNER_PG_URL` is not set. */
export class JsonFileUiRunStore implements UiRunStore {
  private readonly filePath: string;

  constructor(reportsDir: string) {
    this.filePath = path.join(reportsDir, "ui-runs.json");
  }

  async insert(row: UiRunRow): Promise<void> {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const rows: UiRunRow[] = existsSync(this.filePath)
      ? (JSON.parse(readFileSync(this.filePath, "utf8")) as UiRunRow[])
      : [];
    rows.push(row);
    writeFileSync(this.filePath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  }
}

/** Postgres-backed `UiRunStore`, table `ui_runs` (controller notes item 6's exact column list).
 *  Used whenever `RUNNER_PG_URL` is set, the same database the pipeline itself uses. */
export class PgUiRunStore implements UiRunStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** Idempotent (`CREATE TABLE IF NOT EXISTS`); safe to call from any process, any number of
   *  times, independent of the pipeline's own `PgRunStore.migrate`. */
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ui_runs (
        run_id TEXT PRIMARY KEY,
        experiment_path TEXT NOT NULL,
        deploy_config_path TEXT NOT NULL,
        log_path TEXT NOT NULL,
        pid INTEGER NOT NULL,
        read_side BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async insert(row: UiRunRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO ui_runs (run_id, experiment_path, deploy_config_path, log_path, pid, read_side)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO UPDATE SET
         experiment_path = EXCLUDED.experiment_path,
         deploy_config_path = EXCLUDED.deploy_config_path,
         log_path = EXCLUDED.log_path,
         pid = EXCLUDED.pid,
         read_side = EXCLUDED.read_side`,
      [row.runId, row.experimentPath, row.deployConfigPath, row.logPath, row.pid, row.readSide],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Picks `PgUiRunStore` when `pgUrl` is set (migrating it first) or `JsonFileUiRunStore` scoped to
 *  `reportsDir` otherwise, mirroring `pipeline/state.ts`'s `openRunStore`. */
export async function openUiRunStore(opts: { pgUrl: string | undefined; reportsDir: string }): Promise<UiRunStore> {
  if (opts.pgUrl) {
    const store = new PgUiRunStore(opts.pgUrl);
    await store.migrate();
    return store;
  }
  return new JsonFileUiRunStore(opts.reportsDir);
}
