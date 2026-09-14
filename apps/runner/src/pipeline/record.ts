import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Hex } from "viem";
import type { ManifestV1 } from "@fleet/schemas";
import type { DecisionTrace, FleetClient } from "@fleet/sdk";
import { getDecisionTrace } from "@fleet/sdk";
import type { FeeEntry, FixtureRunResult } from "./fixture-runner.js";

/** JSON.stringify's replacer, applied everywhere a record document is written: every `bigint`
 *  becomes its decimal string, never a JS `number` (a run's self-review requirement: nothing in
 *  `record.json` may be `number` where the chain uses `uint256`). */
function bigintSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function writeJsonRecord(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, bigintSafeReplacer, 2)}\n`, "utf8");
}

export function readJsonRecord<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

export type RecordEvent = Record<string, unknown> & { fixtureName: string; blockHash: string };
export type RecordVote = {
  fixtureName: string;
  agentId: number;
  voterAddress: string;
  proposalId: string;
  support: 0 | 1 | 2 | null;
  vote: FixtureRunResult["votes"][number]["vote"];
  onchainReason: string | null;
  jobState: string;
  txHash: string | null;
};
export type RecordJob = {
  fixtureName: string;
  agentId: number;
  directive: string;
  jobState: string;
  txHash: string | null;
  lastError: string | null;
};
export type RecordProposalRef = { fixtureName: string; taskId: string; proposalId: string; outcome: string; expectedOutcome: string; pass: boolean };

export type RunRecordDocument = {
  schema: "fleet.record.v1";
  runId: string;
  config: unknown;
  configHash: string;
  manifest: ManifestV1;
  proposals: RecordProposalRef[];
  events: RecordEvent[];
  gatewayLog: unknown[];
  jobs: RecordJob[];
  votes: RecordVote[];
  timings: Record<string, unknown>;
  fees: FeeEntry[];
  metrics: Record<string, unknown>;
  versions: Record<string, unknown>;
};

/** Fetches (and memoizes within one call) the block hash for every unique tx hash in `events`, so
 *  every event carries `blockNumber`, `blockHash`, `txHash`, and `logIndex` (spec 12.4), even
 *  though `DecisionTraceEvent` itself does not carry `blockHash`. */
async function attachBlockHashes(
  client: FleetClient,
  fixtureName: string,
  events: readonly (Record<string, unknown> & { txHash: Hex })[],
): Promise<RecordEvent[]> {
  const cache = new Map<string, string>();
  const out: RecordEvent[] = [];
  for (const event of events) {
    const key = event.txHash.toLowerCase();
    let blockHash = cache.get(key);
    if (!blockHash) {
      const receipt = await client.publicClient.getTransactionReceipt({ hash: event.txHash });
      blockHash = receipt.blockHash;
      cache.set(key, blockHash);
    }
    out.push({ ...event, fixtureName, blockHash } as RecordEvent);
  }
  return out;
}

function votesFromFixture(result: FixtureRunResult): RecordVote[] {
  const traceVotesByVoter = new Map(
    result.trace.events
      .filter((e): e is Extract<typeof e, { type: "VoteCast" }> => e.type === "VoteCast")
      .map((e) => [e.voter.toLowerCase(), e]),
  );
  return result.votes.map((v) => {
    const onchain = traceVotesByVoter.get(v.voterAddress.toLowerCase());
    return {
      fixtureName: result.fixture.name,
      agentId: v.agentId,
      voterAddress: v.voterAddress,
      proposalId: result.proposalId.toString(),
      support: onchain?.support ?? null,
      vote: v.vote,
      onchainReason: onchain?.reason ?? null,
      jobState: v.jobState,
      txHash: v.txHash,
    };
  });
}

function jobsFromFixture(result: FixtureRunResult): RecordJob[] {
  return result.votes.map((v) => ({
    fixtureName: result.fixture.name,
    agentId: v.agentId,
    directive: v.directive,
    jobState: v.jobState,
    txHash: v.txHash,
    lastError: v.lastError,
  }));
}

function metricsFromResults(results: readonly FixtureRunResult[]): Record<string, unknown> {
  const outcomeDistribution: Record<string, number> = {};
  let totalFeesWei = 0n;
  let missingVotesTotal = 0;
  let revertedAttemptsTotal = 0;
  for (const r of results) {
    outcomeDistribution[r.finalStateName] = (outcomeDistribution[r.finalStateName] ?? 0) + 1;
    missingVotesTotal += r.missingVotes;
    if (r.impostor) {
      revertedAttemptsTotal += Number(r.impostor.proposeReverted) + Number(r.impostor.voteReverted);
    }
    for (const fee of r.fees) totalFeesWei += BigInt(fee.feeWei);
  }
  return {
    fixtureCount: results.length,
    passCount: results.filter((r) => r.pass).length,
    outcomeDistribution,
    missingVotesTotal,
    revertedAttemptsTotal,
    totalFeesWei: totalFeesWei.toString(),
  };
}

/**
 * Assembles `record.json` (spec 12.4) from a completed set of fixture runs: `config`/`configHash`,
 * the deployment `manifest`, every chain event (block number, block hash, tx hash, log index,
 * decoded), the gateway allow/block log, every worker job, every vote (`VoteV1` plus its onchain
 * reason), timings, per-tx fees, derived metrics, and pinned versions.
 */
export async function buildRecord(opts: {
  client: FleetClient;
  runId: string;
  config: unknown;
  configHash: string;
  manifest: ManifestV1;
  results: readonly FixtureRunResult[];
  timings: Record<string, unknown>;
  versions: Record<string, unknown>;
}): Promise<RunRecordDocument> {
  const events: RecordEvent[] = [];
  const gatewayLog: unknown[] = [];
  const jobs: RecordJob[] = [];
  const votes: RecordVote[] = [];
  const fees: FeeEntry[] = [];
  const proposals: RecordProposalRef[] = [];

  for (const result of opts.results) {
    const fixtureEvents = await attachBlockHashes(
      opts.client,
      result.fixture.name,
      result.trace.events as unknown as (Record<string, unknown> & { txHash: Hex })[],
    );
    events.push(...fixtureEvents);
    if (result.gatewayBefore) gatewayLog.push(result.gatewayBefore);
    if (result.gatewayAfter) gatewayLog.push(result.gatewayAfter);
    jobs.push(...jobsFromFixture(result));
    votes.push(...votesFromFixture(result));
    fees.push(...result.fees);
    proposals.push({
      fixtureName: result.fixture.name,
      taskId: result.taskId.toString(),
      proposalId: result.proposalId.toString(),
      outcome: result.finalStateName,
      expectedOutcome: result.fixture.expected.outcome,
      pass: result.pass,
    });
  }

  return {
    schema: "fleet.record.v1",
    runId: opts.runId,
    config: opts.config,
    configHash: opts.configHash,
    manifest: opts.manifest,
    proposals,
    events,
    gatewayLog,
    jobs,
    votes,
    timings: opts.timings,
    fees,
    metrics: metricsFromResults(opts.results),
    versions: opts.versions,
  };
}

/** Reads one transaction's receipt from chain and turns it into a `FeeEntry`. Every value is read
 *  back from the chain, never copied from the record being re-captured. */
async function feeFromChain(client: FleetClient, txHash: Hex): Promise<FeeEntry> {
  const receipt = await client.publicClient.getTransactionReceipt({ hash: txHash });
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  return {
    txHash,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    feeWei: (receipt.gasUsed * effectiveGasPrice).toString(),
  };
}

/**
 * `fleet capture --from-chain`: rebuilds only the chain-derived sections of an existing
 * `record.json` (`events[]`, `votes[]`'s `onchainReason`/`support`, and `fees[]`) purely from
 * `proposals[]` (`{fixtureName, taskId, proposalId}`, already in the record) and chain logs,
 * never from `jobs[]` or any other locally-remembered bookkeeping. Everything else in the
 * document (`config`, `manifest`, `gatewayLog`, `jobs`, `timings`, `metrics`, `versions`) is kept
 * unchanged from `existing`.
 *
 * `fees[]` is the union of the transactions in the re-fetched traces and the transaction hashes
 * the record already lists. Final review I7: rebuilding it from the trace alone silently dropped
 * every fee receipt for a transaction that emits no proposal event, which is the delegation
 * pre-steps and the guardian's pause, cancel and unpause, so a `guardian-cancel` re-capture lost
 * three receipts and a `delegation-visible` re-capture lost two, and spec 12.4 requires the
 * re-capture to "reproduce the chain-derived parts of the record exactly". Only the hashes come
 * from the record; every value is re-read from the chain, so a fee entry is still chain-derived
 * rather than copied.
 */
export async function captureFromChain(
  client: FleetClient,
  existing: RunRecordDocument,
  fetchTrace: (client: FleetClient, proposalId: bigint) => Promise<DecisionTrace> = getDecisionTrace,
): Promise<RunRecordDocument> {
  const events: RecordEvent[] = [];
  const votes: RecordVote[] = [];
  const fees: FeeEntry[] = [];
  const feeCache = new Set<string>();

  for (const ref of existing.proposals) {
    const proposalId = BigInt(ref.proposalId);
    const trace = await fetchTrace(client, proposalId);
    const fixtureEvents = await attachBlockHashes(
      client,
      ref.fixtureName,
      trace.events as unknown as (Record<string, unknown> & { txHash: Hex })[],
    );
    events.push(...fixtureEvents);

    const originalVotesForFixture = existing.votes.filter((v) => v.fixtureName === ref.fixtureName);
    const voteCasts = trace.events.filter((e): e is Extract<typeof e, { type: "VoteCast" }> => e.type === "VoteCast");
    const onchainVoters = new Set(voteCasts.map((v) => v.voter.toLowerCase()));

    // Agents whose job never produced an onchain vote at all (absent, missed, worker_failed, ...)
    // have nothing to rebuild from chain data (chain has no record of a vote that never happened);
    // their original entry (already `onchainReason: null`) is kept verbatim.
    for (const original of originalVotesForFixture) {
      if (!onchainVoters.has(original.voterAddress.toLowerCase())) {
        votes.push(original);
      }
    }

    for (const voteCast of voteCasts) {
      const original = originalVotesForFixture.find((v) => v.voterAddress.toLowerCase() === voteCast.voter.toLowerCase());
      votes.push({
        fixtureName: ref.fixtureName,
        agentId: original?.agentId ?? -1,
        voterAddress: voteCast.voter,
        proposalId: ref.proposalId,
        support: voteCast.support,
        vote: original?.vote ?? null,
        onchainReason: voteCast.reason,
        jobState: original?.jobState ?? "voted",
        txHash: voteCast.txHash,
      });
    }

    for (const event of trace.events) {
      const key = event.txHash.toLowerCase();
      if (feeCache.has(key)) continue;
      feeCache.add(key);
      fees.push(await feeFromChain(client, event.txHash));
    }
  }

  // The transactions the record already knows about but no proposal event mentions: the delegation
  // pre-steps and the guardian's pause, cancel and unpause (final review I7).
  for (const existingFee of existing.fees) {
    const key = existingFee.txHash.toLowerCase();
    if (feeCache.has(key)) continue;
    feeCache.add(key);
    fees.push(await feeFromChain(client, existingFee.txHash));
  }

  return { ...existing, events, votes, fees };
}
