import type { Hex } from "viem";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The `pg.Pool` surface `insertVoteRow` needs; narrowed so a unit test can pass a plain mock
 *  instead of a real connection pool. */
export type QueryablePool = { query: (text: string, values: unknown[]) => Promise<unknown> };

export type VoteRowInput = {
  proposalId: string;
  transactionHash: Hex;
  blockNumber: bigint;
  chainId: number;
  voter: string;
  support: 0 | 1 | 2;
  weight: bigint;
  reason: string;
  contract: string;
};

/**
 * Inserts one row into `fleet.votes` (Postgres, database `agora_web3`), CPLS's actual vote
 * source for a DAO-node-tracked proposal (`docs/compatibility-notes.md`, Task 6: "CPLS reads
 * votes from Postgres, not from DAO Node"), matching `infra/scripts/scripted-proposal.sh`'s own
 * `insert_vote_row` column-for-column: every value is either read straight off the chain
 * (`transactionHash`/`blockNumber`/`weight` from the vote's own `VoteCast` event and receipt,
 * `voter`/`support`/`reason` from the transaction that cast it) or a deployment constant
 * (`chainId`, `contract`, the governor's own address). `params` is always `NULL`: this governor
 * has no voting module that uses it. `ON CONFLICT DO NOTHING` matches the unique index on
 * `(contract, proposal_id, voter)` (`infra/postgres/init/04-fleet-indexes.sql`), so calling this
 * again for a vote already inserted (a resumed fixture, task 8 finding 1) is a no-op, not a
 * duplicate row.
 */
export async function insertVoteRow(pool: QueryablePool, row: VoteRowInput): Promise<void> {
  await pool.query(
    `INSERT INTO fleet.votes (proposal_id, transaction_hash, block_number, chain_id, voter, support, weight, reason, params, contract)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)
     ON CONFLICT DO NOTHING`,
    [
      row.proposalId,
      row.transactionHash,
      row.blockNumber.toString(),
      row.chainId,
      row.voter.toLowerCase(),
      row.support,
      row.weight.toString(),
      row.reason,
      row.contract.toLowerCase(),
    ],
  );
}

export type CplsJobIdentity = { governor: string; chainId: number };

/** The one CPLS job payload every sync posts, exactly as `docs/compatibility-notes.md` (Task 6)
 *  and `infra/scripts/scripted-proposal.sh`'s `CPLS_JOB_BODY` document it. `token.address` reuses
 *  the governor address: `DaoNodeSync`'s quorum/vote-source logic for this local stack never reads
 *  it, but the field must be present. */
export function buildCplsJobBody(identity: CplsJobIdentity): unknown {
  const gov = identity.governor.toLowerCase();
  return {
    type: "sync_daonode",
    payload: {
      infra_dao_slug: "fleet",
      logic: "refresh_list",
      sources: ["dao_node"],
      reset: true,
      config: {
        schema: "fleet",
        dao_slug: "FLEET",
        index_tenant_prefix: "fleet",
        features: { oodao: false, snapshot_proposals: false, dao_node_proposals: true },
        deployment: { chain_id: identity.chainId, gov: { address: gov }, token: { address: gov } },
      },
    },
  };
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** POSTs a CPLS sync job and polls `GET /jobs/<id>` until it reports `"completed"` (returns) or
 *  `"failed"` (throws), bounded by `timeoutMs`. Mirrors `scripted-proposal.sh`'s
 *  `trigger_cpls_job`. */
export async function triggerCplsJob(
  fetchFn: FetchLike,
  cplsUrl: string,
  identity: CplsJobIdentity,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 2000;
  const base = cplsUrl.replace(/\/$/, "");
  const body = buildCplsJobBody(identity);

  const postRes = await fetchFn(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!postRes.ok) {
    throw new Error(`CPLS POST /jobs failed with status ${postRes.status}`);
  }
  const posted = (await postRes.json()) as { job_id?: string };
  if (!posted.job_id) {
    throw new Error(`CPLS POST /jobs response carried no job_id: ${JSON.stringify(posted)}`);
  }
  const jobId = posted.job_id;

  const start = Date.now();
  for (;;) {
    const res = await fetchFn(`${base}/jobs/${jobId}`);
    const data = (await res.json()) as { status?: string };
    if (data.status === "completed") return;
    if (data.status === "failed") {
      throw new Error(`CPLS job ${jobId} failed: ${JSON.stringify(data)}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`CPLS job ${jobId} did not reach "completed" within ${timeoutMs}ms (last status: ${JSON.stringify(data)})`);
    }
    await sleep(pollMs);
  }
}

export type ArchiveWaitConfig = {
  offline: boolean;
  bucketName: string;
  /** Required (and only used) when `offline` is true: the fake-gcs base URL. */
  fakeGcsUrl?: string;
};

/** Waits for `data/fleet/votes/<proposalId>.ndjson.gz` to actually exist in the archive store:
 *  offline, in the fake-gcs bucket listing; against real GCS, a `HEAD` on the object's public URL.
 *  Mirrors `scripted-proposal.sh`'s `sync_stage`'s archive wait (the same object path is checked
 *  after every stage; CPLS writes it as soon as it discovers the proposal at all, even with zero
 *  votes archived yet, and overwrites it on each later sync). */
export async function waitForArchiveObject(
  fetchFn: FetchLike,
  cfg: ArchiveWaitConfig,
  proposalId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 2000;
  const objectName = `data/fleet/votes/${proposalId}.ndjson.gz`;

  const start = Date.now();
  for (;;) {
    let found = false;
    if (cfg.offline) {
      if (!cfg.fakeGcsUrl) throw new Error("waitForArchiveObject: offline mode requires fakeGcsUrl");
      try {
        const res = await fetchFn(`${cfg.fakeGcsUrl.replace(/\/$/, "")}/storage/v1/b/${cfg.bucketName}/o`);
        if (res.ok) {
          const data = (await res.json()) as { items?: { name: string }[] };
          found = (data.items ?? []).some((item) => item.name === objectName);
        }
      } catch {
        found = false;
      }
    } else {
      try {
        const res = await fetchFn(`https://storage.googleapis.com/${cfg.bucketName}/${objectName}`, { method: "HEAD" });
        found = res.ok;
      } catch {
        found = false;
      }
    }
    if (found) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`archive object ${objectName} did not appear within ${timeoutMs}ms`);
    }
    await sleep(pollMs);
  }
}

/** Posts a CPLS sync job and waits for its archive object to appear, in that order. The one
 *  function `runFixture` calls after every governance transaction when the read side is enabled
 *  (task 8 finding 3). */
export async function syncCplsAfterStage(
  fetchFn: FetchLike,
  opts: { cplsUrl: string; identity: CplsJobIdentity; archive: ArchiveWaitConfig; proposalId: string; label: string; log?: (message: string) => void },
): Promise<void> {
  const log = opts.log ?? (() => {});
  log(`cpls sync (${opts.label}): posting job for proposal ${opts.proposalId}`);
  await triggerCplsJob(fetchFn, opts.cplsUrl, opts.identity);
  await waitForArchiveObject(fetchFn, opts.archive, opts.proposalId);
  log(`cpls sync (${opts.label}): archive object present for proposal ${opts.proposalId}`);
}

/** Polls a DAO Node JSON endpoint until `predicate` is satisfied, bounded by `timeoutMs`. Used to
 *  wait for DAO Node to index a proposal or a vote before triggering a CPLS sync, mirroring
 *  `scripted-proposal.sh`'s own `wait-for.sh` calls ahead of each `sync_stage`. */
export async function waitForDaoNode(
  fetchFn: FetchLike,
  url: string,
  predicate: (body: unknown) => boolean,
  opts: { timeoutMs?: number; pollMs?: number; description?: string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 2000;
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetchFn(url);
      if (res.ok) {
        const body = await res.json();
        if (predicate(body)) return;
      }
    } catch {
      // not ready yet
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${opts.description ?? url}`);
    }
    await sleep(pollMs);
  }
}
