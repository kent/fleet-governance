import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * The run pipeline's stages, spec 12.2's ordering. `fleet run` drives a run through every one of
 * these in order; `fleet capture`/`fleet report` re-run only the tail. Per-proposal sub-states
 * (`PROPOSED -> ACTIVE -> CLOSED -> QUEUED -> EXECUTED|DEFEATED|CANCELED`) are not separate
 * top-level stages here: they happen inside `AGENTS_RUNNING`, one full cycle per fixture, and are
 * captured in the run's payload (`fixtures[]`) rather than as their own persisted checkpoints,
 * since a fixture's own proposal lifecycle is already independently re-derivable from chain data
 * (`fleet capture --from-chain`).
 */
export const STAGE_ORDER = [
  "PREFLIGHT",
  "CHAIN_READY",
  "DEPLOYED",
  "VERIFIED",
  "INDEXERS_READY",
  "TASK_OPENED",
  "AGENTS_RUNNING",
  "TASK_ENDED",
  "CAPTURED",
  "REPORTED",
] as const;
export type StageName = (typeof STAGE_ORDER)[number];

export type RunRecord = {
  runId: string;
  stage: StageName;
  updatedAt: string;
  payload: Record<string, unknown>;
};

/** Where `fleet run` persists which stage a run last completed, and that stage's own
 *  JSON-serializable payload, so `--run-id <id>` can resume without redoing finished work.
 *  Postgres-backed (`RUNNER_PG_URL` set, table `runs`) or a JSON file under the run's report
 *  directory (`RUNNER_PG_URL` unset), per the task 8 controller notes. */
export interface RunStore {
  get(runId: string): Promise<RunRecord | null>;
  save(record: RunRecord): Promise<void>;
}

/** One pipeline stage: a name (persisted as the resume checkpoint) and a function from the
 *  current in-memory context to the next one. Every stage implementation must be idempotent,
 *  checking chain or filesystem state before acting, so re-running a stage that already
 *  completed (as `runStages` does whenever resuming lands back on a partially-run stage) is
 *  always safe. */
export type Stage<Ctx> = {
  name: StageName;
  run(ctx: Ctx): Promise<Ctx>;
};

/**
 * Runs `stages` in order against `ctx`, persisting a checkpoint to `store` after each one
 * completes. When `store` already holds a record for `runId`, resumes immediately after that
 * record's stage rather than from the top; stage functions are still expected to no-op quickly
 * when there is nothing left to do (`runStages` does not skip re-invoking a stage on faith alone
 * beyond this index-based resume).
 *
 * `rehydrate` is what makes a resume more than an index: the checkpoint carries the finished
 * stages' own `toPayload` output, and a fresh process's `ctx` is empty, so without it every stage
 * after the resume point runs against nulls. Final review I1: `runStages` read only
 * `existing.stage` and never `existing.payload`, so any resume at or after `DEPLOYED` reached
 * `TASK_OPENED` with no manifest and threw.
 */
export async function runStages<Ctx>(opts: {
  runId: string;
  store: RunStore;
  stages: readonly Stage<Ctx>[];
  ctx: Ctx;
  toPayload: (ctx: Ctx) => Record<string, unknown>;
  onStage?: (name: StageName, ctx: Ctx) => void | Promise<void>;
  /** Rebuilds whatever the finished stages put in the context from the persisted payload. Called
   *  once, before the first resumed stage runs, and only when there is a checkpoint to resume
   *  from. */
  rehydrate?: (ctx: Ctx, payload: Record<string, unknown>) => Ctx | Promise<Ctx>;
}): Promise<Ctx> {
  const { runId, store, stages, toPayload, onStage, rehydrate } = opts;
  let ctx = opts.ctx;

  const existing = await store.get(runId);
  const startIndex = existing ? stages.findIndex((s) => s.name === existing.stage) + 1 : 0;
  if (existing && startIndex === 0) {
    throw new Error(
      `run ${runId}: persisted stage "${existing.stage}" is not one of the stages this pipeline was given`,
    );
  }
  if (existing && rehydrate) {
    ctx = await rehydrate(ctx, existing.payload);
  }

  for (let i = startIndex; i < stages.length; i++) {
    const stage = stages[i]!;
    ctx = await stage.run(ctx);
    await store.save({ runId, stage: stage.name, updatedAt: new Date().toISOString(), payload: toPayload(ctx) });
    if (onStage) await onStage(stage.name, ctx);
  }

  return ctx;
}

/** In-memory `RunStore`; used by unit tests only (never durable across processes). */
export class MemoryRunStore implements RunStore {
  private readonly records = new Map<string, RunRecord>();

  async get(runId: string): Promise<RunRecord | null> {
    const record = this.records.get(runId);
    return record ? { ...record, payload: { ...record.payload } } : null;
  }

  async save(record: RunRecord): Promise<void> {
    this.records.set(record.runId, { ...record, payload: { ...record.payload } });
  }
}

/**
 * JSON-file `RunStore`: one `run-state.json` file under `runDir` (the specific run's own report
 * directory, e.g. `<reportDir>/<runId>/`), holding the single latest `RunRecord` for that run.
 * Used whenever `RUNNER_PG_URL` is not set (task 8 controller notes).
 */
export class JsonFileRunStore implements RunStore {
  private readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  private filePath(): string {
    return path.join(this.runDir, "run-state.json");
  }

  async get(runId: string): Promise<RunRecord | null> {
    const file = this.filePath();
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as RunRecord;
    if (parsed.runId !== runId) return null;
    return parsed;
  }

  async save(record: RunRecord): Promise<void> {
    mkdirSync(this.runDir, { recursive: true });
    writeFileSync(this.filePath(), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
}

/** Postgres-backed `RunStore`, table `runs` (columns `run_id`, `stage`, `updated_at`, `payload
 *  jsonb`), one row per run holding its latest checkpoint. Used whenever `RUNNER_PG_URL` is set
 *  (task 8 controller notes: "Run state persisted in Postgres (`runs` table) when
 *  `RUNNER_PG_URL` is set, else a JSON file"). */
export class PgRunStore implements RunStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** Idempotent (`CREATE TABLE IF NOT EXISTS`); safe to call any number of times, from any
   *  process, in any order relative to `PgJobStore.migrate`/`PgNonceStore.migrate`. */
  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        payload JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
  }

  async get(runId: string): Promise<RunRecord | null> {
    const res = await this.pool.query<{ run_id: string; stage: StageName; updated_at: Date; payload: Record<string, unknown> }>(
      "SELECT run_id, stage, updated_at, payload FROM runs WHERE run_id = $1",
      [runId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { runId: row.run_id, stage: row.stage, updatedAt: row.updated_at.toISOString(), payload: row.payload };
  }

  async save(record: RunRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO runs (run_id, stage, updated_at, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id) DO UPDATE SET stage = EXCLUDED.stage, updated_at = EXCLUDED.updated_at, payload = EXCLUDED.payload`,
      [record.runId, record.stage, record.updatedAt, JSON.stringify(record.payload)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Picks `PgRunStore` when `pgUrl` is set (migrating it first) or `JsonFileRunStore` scoped to
 *  `runDir` otherwise. The one place `fleet`'s commands decide which backing store a run uses. */
export async function openRunStore(opts: { pgUrl: string | undefined; runDir: string }): Promise<RunStore> {
  if (opts.pgUrl) {
    const store = new PgRunStore(opts.pgUrl);
    await store.migrate();
    return store;
  }
  return new JsonFileRunStore(opts.runDir);
}
