import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Address, Hex } from "viem";
import type { VoteV1 } from "@fleet/schemas";
import type { NonceAccountState, NonceStore, PendingNonce } from "@fleet/sdk";

/** The five write actions a job can carry out (spec 10.8's unique job key), even though this
 *  part's `Worker` only ever creates `"vote"` jobs. */
export type ActionType = "vote" | "propose" | "delegate" | "queue" | "execute";

/** Unique job key, spec 10.8: `(chainId, governor, proposalId, agentAddress, actionType)`. */
export type JobKey = {
  chainId: number;
  governor: Address;
  proposalId: string;
  agentAddress: Address;
  actionType: ActionType;
};

/**
 * The worker state machine's own phases, spec 10.4, persisted after every transition.
 *
 * `SIMULATE` and `REQUEST_SIGNATURE` are both persisted immediately before the single call to
 * `FleetSigner.castVoteWithReason` (see `Worker.requestSignatureAndBeyond`'s doc comment): that
 * call simulates internally before it signs and sends, but the boundary between those two steps
 * is not observable from outside the signer, so there is no separate "simulated, about to sign"
 * checkpoint between them on disk. `REQUEST_SIGNATURE` is the one of the two a restart resumes
 * from.
 */
export type JobPipelineState =
  | "DISCOVER"
  | "READ_ANCHORED_STATE"
  | "EVALUATE"
  | "VALIDATE"
  | "SIMULATE"
  | "REQUEST_SIGNATURE"
  | "SUBMIT"
  | "CONFIRM"
  | "RECONCILE";

/** Where a job can come to rest: `"voted"` is the only success outcome; the rest are the
 *  no-cast and refusal outcomes spec 10.6 to 10.8 name explicitly. */
export type JobTerminalState =
  | "voted"
  | "absent"
  | "worker_failed"
  | "refused_for_on_mismatch"
  | "missed"
  | "already_voted";

export type JobState = JobPipelineState | JobTerminalState;

/**
 * Durable record for one job key. Beyond `state` and the identifying key fields, carries: the
 * anchor this job read state at (`inputBlockNumber`/`inputBlockHash`); a hash of the agent
 * manifest text the policy reasoned from (`manifestHash`); provider/model bookkeeping this part
 * always leaves `null` (`ScriptedPolicy` has no concept of a provider or model; Part 4's
 * model-backed policies populate these); the ballot a policy chose (`vote`) and the exact text
 * sent onchain as the vote reason (`publicReason`); the nonce and tx hash a submission used;
 * the transaction's outcome (`receipt`, a plain-JSON-safe projection, not the raw viem receipt);
 * a retry counter and the last failure or refusal detail (`attempts`, `lastError`); and
 * `createdAt`/`updatedAt` timestamps.
 */
export type JobRecord = JobKey & {
  state: JobState;
  inputBlockNumber: bigint | null;
  inputBlockHash: Hex | null;
  manifestHash: Hex | null;
  providerId: string | null;
  modelId: string | null;
  promptVersion: string | null;
  inferenceLatencyMs: number | null;
  usage: Record<string, number> | null;
  vote: VoteV1 | null;
  publicReason: string | null;
  nonce: number | null;
  txHash: Hex | null;
  receipt: unknown | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobFilter = Partial<JobKey> & { state?: JobState };

/**
 * Durable storage for job records, keyed by `JobKey`, so a worker restart never double-votes:
 * every transition of the state machine is persisted here before the next one runs.
 */
export interface JobStore {
  /** Atomically creates the job row for `key` if it does not already exist, starting at
   *  `"DISCOVER"`. Two concurrent `claim` calls on the same, not-yet-existing key: exactly one
   *  gets the new record back, the other gets `null`. A key that already exists (whether from an
   *  earlier run of this same job, or a claim that just won the race) also yields `null`; callers
   *  that want to resume an existing job use `get`, not `claim`, to fetch it. */
  claim(key: JobKey): Promise<JobRecord | null>;
  /** Merges `patch` into the existing record for `key` and stamps `updatedAt`. Throws if no
   *  record exists for `key` (a job must be `claim`ed before it can be updated). */
  update(key: JobKey, patch: Partial<JobRecord>): Promise<void>;
  get(key: JobKey): Promise<JobRecord | null>;
  list(filter: JobFilter): Promise<JobRecord[]>;
}

function jobKeyString(key: JobKey): string {
  return [key.chainId, key.governor.toLowerCase(), key.proposalId, key.agentAddress.toLowerCase(), key.actionType].join(
    "|",
  );
}

/** The error every `JobStore.update` implementation throws for a key with no existing record
 *  (the `JobStore` contract: "Throws if no record exists for `key`"), so callers see the same
 *  failure shape regardless of which store backs them. */
function noJobRecordError(key: JobKey): Error {
  return new Error(`no job record for key ${jobKeyString(key)}`);
}

function freshRecord(key: JobKey, now: Date): JobRecord {
  return {
    chainId: key.chainId,
    governor: key.governor,
    proposalId: key.proposalId,
    agentAddress: key.agentAddress,
    actionType: key.actionType,
    state: "DISCOVER",
    inputBlockNumber: null,
    inputBlockHash: null,
    manifestHash: null,
    providerId: null,
    modelId: null,
    promptVersion: null,
    inferenceLatencyMs: null,
    usage: null,
    vote: null,
    publicReason: null,
    nonce: null,
    txHash: null,
    receipt: null,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** In-process `JobStore`, correct as long as one process is the only writer. Used by every test
 *  that does not need `RUNNER_PG_URL`. */
export class MemoryJobStore implements JobStore {
  private readonly records = new Map<string, JobRecord>();

  async claim(key: JobKey): Promise<JobRecord | null> {
    const k = jobKeyString(key);
    if (this.records.has(k)) return null;
    const record = freshRecord(key, new Date());
    this.records.set(k, record);
    return { ...record };
  }

  async update(key: JobKey, patch: Partial<JobRecord>): Promise<void> {
    const k = jobKeyString(key);
    const existing = this.records.get(k);
    if (!existing) {
      throw noJobRecordError(key);
    }
    this.records.set(k, { ...existing, ...patch, updatedAt: new Date() });
  }

  async get(key: JobKey): Promise<JobRecord | null> {
    const existing = this.records.get(jobKeyString(key));
    return existing ? { ...existing } : null;
  }

  async list(filter: JobFilter): Promise<JobRecord[]> {
    return [...this.records.values()]
      .filter((r) => {
        if (filter.chainId !== undefined && r.chainId !== filter.chainId) return false;
        if (filter.governor !== undefined && r.governor.toLowerCase() !== filter.governor.toLowerCase()) return false;
        if (filter.proposalId !== undefined && r.proposalId !== filter.proposalId) return false;
        if (filter.agentAddress !== undefined && r.agentAddress.toLowerCase() !== filter.agentAddress.toLowerCase()) {
          return false;
        }
        if (filter.actionType !== undefined && r.actionType !== filter.actionType) return false;
        if (filter.state !== undefined && r.state !== filter.state) return false;
        return true;
      })
      .map((r) => ({ ...r }));
  }
}

const migrationPath = fileURLToPath(new URL("./migrations/001_jobs.sql", import.meta.url));

function loadMigrationSql(): string {
  return readFileSync(migrationPath, "utf8");
}

/** JobRecord field name -> `jobs` table column name, for every field `update` is allowed to
 *  patch. Key fields and `createdAt` are set once at `claim` time and never patched. */
const PATCHABLE_COLUMNS: Record<string, string> = {
  state: "state",
  inputBlockNumber: "input_block_number",
  inputBlockHash: "input_block_hash",
  manifestHash: "manifest_hash",
  providerId: "provider_id",
  modelId: "model_id",
  promptVersion: "prompt_version",
  inferenceLatencyMs: "inference_latency_ms",
  usage: "usage",
  vote: "vote",
  publicReason: "public_reason",
  nonce: "nonce",
  txHash: "tx_hash",
  receipt: "receipt",
  attempts: "attempts",
  lastError: "last_error",
};

/** Converts one JS value into the shape `pg` should bind for its column: `bigint` -> decimal
 *  string (pg cannot bind a raw `bigint`, and `JSON.stringify` throws on one); everything else
 *  passes through unchanged (pg's own parameter serialization handles plain objects for `jsonb`
 *  columns). */
function serializeColumn(value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

type JobRow = {
  chain_id: number;
  governor: string;
  proposal_id: string;
  agent_address: string;
  action_type: ActionType;
  state: JobState;
  input_block_number: string | null;
  input_block_hash: string | null;
  manifest_hash: string | null;
  provider_id: string | null;
  model_id: string | null;
  prompt_version: string | null;
  inference_latency_ms: number | null;
  usage: Record<string, number> | null;
  vote: VoteV1 | null;
  public_reason: string | null;
  nonce: number | null;
  tx_hash: string | null;
  receipt: unknown | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

function rowToRecord(row: JobRow): JobRecord {
  return {
    chainId: row.chain_id,
    governor: row.governor as Address,
    proposalId: row.proposal_id,
    agentAddress: row.agent_address as Address,
    actionType: row.action_type,
    state: row.state,
    inputBlockNumber: row.input_block_number === null ? null : BigInt(row.input_block_number),
    inputBlockHash: row.input_block_hash as Hex | null,
    manifestHash: row.manifest_hash as Hex | null,
    providerId: row.provider_id,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    inferenceLatencyMs: row.inference_latency_ms,
    usage: row.usage,
    vote: row.vote,
    publicReason: row.public_reason,
    nonce: row.nonce,
    txHash: row.tx_hash as Hex | null,
    receipt: row.receipt,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Postgres-backed `JobStore`, table `jobs` keyed by `(chain_id, governor, proposal_id,
 * agent_address, action_type)`. `claim` uses `INSERT ... ON CONFLICT DO NOTHING RETURNING *`, so
 * the unique constraint itself is what makes two concurrent claims on the same key resolve to
 * exactly one winner: whichever `INSERT` the database serializes first gets the row back, the
 * other gets zero rows (`null`).
 */
export class PgJobStore implements JobStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** Applies `src/migrations/001_jobs.sql`. Idempotent: every statement in it is `CREATE TABLE
   *  IF NOT EXISTS`, so calling this more than once (including from `PgNonceStore.migrate`,
   *  which applies the same file for the `nonces` table it also declares) is safe. */
  async migrate(): Promise<void> {
    await this.pool.query(loadMigrationSql());
  }

  async claim(key: JobKey): Promise<JobRecord | null> {
    const res = await this.pool.query<JobRow>(
      `INSERT INTO jobs (chain_id, governor, proposal_id, agent_address, action_type, state, attempts)
       VALUES ($1, $2, $3, $4, $5, 'DISCOVER', 0)
       ON CONFLICT (chain_id, governor, proposal_id, agent_address, action_type) DO NOTHING
       RETURNING *`,
      [key.chainId, key.governor.toLowerCase(), key.proposalId, key.agentAddress.toLowerCase(), key.actionType],
    );
    if (res.rows.length === 0) return null;
    return rowToRecord(res.rows[0]!);
  }

  async get(key: JobKey): Promise<JobRecord | null> {
    const res = await this.pool.query<JobRow>(
      `SELECT * FROM jobs WHERE chain_id = $1 AND governor = $2 AND proposal_id = $3 AND agent_address = $4 AND action_type = $5`,
      [key.chainId, key.governor.toLowerCase(), key.proposalId, key.agentAddress.toLowerCase(), key.actionType],
    );
    if (res.rows.length === 0) return null;
    return rowToRecord(res.rows[0]!);
  }

  async update(key: JobKey, patch: Partial<JobRecord>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [field, column] of Object.entries(PATCHABLE_COLUMNS)) {
      if (!(field in patch)) continue;
      sets.push(`${column} = $${i}`);
      values.push(serializeColumn((patch as Record<string, unknown>)[field]));
      i++;
    }
    sets.push("updated_at = now()");

    const whereStart = i;
    values.push(key.chainId, key.governor.toLowerCase(), key.proposalId, key.agentAddress.toLowerCase(), key.actionType);
    // RETURNING (and the rowCount check below) is what makes this match the JobStore contract:
    // an UPDATE whose WHERE clause matches no row otherwise succeeds silently in Postgres.
    const res = await this.pool.query(
      `UPDATE jobs SET ${sets.join(", ")}
       WHERE chain_id = $${whereStart} AND governor = $${whereStart + 1} AND proposal_id = $${whereStart + 2}
         AND agent_address = $${whereStart + 3} AND action_type = $${whereStart + 4}
       RETURNING chain_id`,
      values,
    );
    if (res.rowCount === 0) {
      throw noJobRecordError(key);
    }
  }

  async list(filter: JobFilter): Promise<JobRecord[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    if (filter.chainId !== undefined) {
      clauses.push(`chain_id = $${i++}`);
      values.push(filter.chainId);
    }
    if (filter.governor !== undefined) {
      clauses.push(`governor = $${i++}`);
      values.push(filter.governor.toLowerCase());
    }
    if (filter.proposalId !== undefined) {
      clauses.push(`proposal_id = $${i++}`);
      values.push(filter.proposalId);
    }
    if (filter.agentAddress !== undefined) {
      clauses.push(`agent_address = $${i++}`);
      values.push(filter.agentAddress.toLowerCase());
    }
    if (filter.actionType !== undefined) {
      clauses.push(`action_type = $${i++}`);
      values.push(filter.actionType);
    }
    if (filter.state !== undefined) {
      clauses.push(`state = $${i++}`);
      values.push(filter.state);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.pool.query<JobRow>(`SELECT * FROM jobs ${where} ORDER BY created_at ASC`, values);
    return res.rows.map(rowToRecord);
  }

  /** Closes the underlying connection pool. Not part of `JobStore`; callers (tests, and any
   *  process shutdown path) that constructed a `PgJobStore` are responsible for calling this. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

type NonceRow = { account: string; next: number; pending: PendingNonce[] };

/**
 * Postgres-backed `NonceStore` (`@fleet/sdk`'s `NonceManager` interface), table `nonces` keyed by
 * lowercased account address. Lives here, alongside `PgJobStore`, because both the worker and the
 * keeper apps need persistent nonces backed by the same database (spec 10.1, 10.8).
 */
export class PgNonceStore implements NonceStore {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** Applies the same `001_jobs.sql` file `PgJobStore.migrate` does; both tables it declares use
   *  `CREATE TABLE IF NOT EXISTS`, so either store can be migrated first, independently. */
  async migrate(): Promise<void> {
    await this.pool.query(loadMigrationSql());
  }

  async get(account: Address): Promise<NonceAccountState> {
    const res = await this.pool.query<NonceRow>("SELECT account, next, pending FROM nonces WHERE account = $1", [
      account.toLowerCase(),
    ]);
    if (res.rows.length === 0) return { next: 0, pending: [] };
    const row = res.rows[0]!;
    return { next: row.next, pending: row.pending };
  }

  async set(account: Address, state: NonceAccountState): Promise<void> {
    await this.pool.query(
      `INSERT INTO nonces (account, next, pending) VALUES ($1, $2, $3)
       ON CONFLICT (account) DO UPDATE SET next = EXCLUDED.next, pending = EXCLUDED.pending`,
      [account.toLowerCase(), state.next, JSON.stringify(state.pending)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
