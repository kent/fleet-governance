import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Address, Hex } from "viem";
import { fleetHookAbi } from "@fleet/abi";
import type { ManifestV1, VoteV1 } from "@fleet/schemas";
import type { DecisionTrace, FleetClient } from "@fleet/sdk";
import { ProposalState, getDecisionTrace } from "@fleet/sdk";
import type { FeeEntry, FixtureRunResult } from "./fixture-runner.js";
import type { ExpectedEvaluation } from "./model-expected.js";
import type { ModelRunResult } from "./model-runner.js";
import { InterventionLine, RUN_FILES, readJsonl } from "./runfiles.js";
import type { GatewayLogLineType, InterventionLineType, ObjectionLineType, StepLineType } from "./runfiles.js";
import { captureExecutionRecord } from "./execution-record.js";
import type { ExecutionRecord } from "./execution-record.js";

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
  vote: VoteV1 | null;
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
export type RecordProposalRef = {
  fixtureName: string;
  taskId: string;
  proposalId: string;
  outcome: string;
  expectedOutcome: string;
  pass: boolean;
  /** Model runs only: what the fleet proposed, who proposed it, and the payload it covers. A
   *  scripted fixture's trigger is already in the fixture file, so these stay absent there. */
  kind?: string;
  payloadHash?: string;
  proposerAgentId?: number;
  summary?: string;
  /** The action descriptor the decision covers, decoded from the proposal's own description. Absent
   *  for an `AMEND_CHARTER`, whose payload is a charter rather than one call. */
  action?: { class: string; target: string; argsHash: string };
  execution?: import("@fleet/schemas").ExecutionPermitV1;
};

/** One agent's task loop, as the run's record remembers it (model runs only). `proposed` carries
 *  decimal proposal id strings, never numbers. */
export type RecordLoop = {
  fixtureName: string;
  agentId: number;
  role: string;
  provider: string;
  model: string;
  isCoordinator: boolean;
  steps: number;
  blocked: number;
  objections: number;
  testsPassed: boolean;
  proposed: string[];
  stopReason: string | null;
  error: string | null;
};

export type RunRecordDocument = {
  schema: "fleet.record.v1";
  runId: string;
  config: unknown;
  configHash: string;
  manifest: ManifestV1;
  /** The one task every proposal in this record belongs to, as a decimal string, when the run
   *  drove exactly one (`fleet run`, scripted or model driven). `null` for a multi-task run such
   *  as `fleet demo`, which opens a fresh task per fixture. `captureFromChain` uses it to
   *  rediscover a model run's proposals from chain, which is the only way to find them: a model
   *  run has no deterministic trigger to recompute. */
  taskId: string | null;
  proposals: RecordProposalRef[];
  events: RecordEvent[];
  /** Contract resource writes and state, independently reconstructed at the recorded chain block. */
  execution?: ExecutionRecord;
  gatewayLog: unknown[];
  jobs: RecordJob[];
  votes: RecordVote[];
  /** The coordinator's published steps (`steps.jsonl`), the members' objection outcomes
   *  (`objections.jsonl`) and the guardian actions taken through the Runner
   *  (`interventions.jsonl`). Empty for a scripted run, which publishes no steps and hears no
   *  objections. */
  steps: StepLineType[];
  objections: ObjectionLineType[];
  humanInterventions: InterventionLineType[];
  /** One entry per agent's task loop, model runs only. */
  loops: RecordLoop[];
  /** The model fixture's own rubric lines and the evaluation of its `expected` block, so a reader
   *  of `record.json` alone can tell what was being checked and what the answer was. */
  rubric: string[];
  expected: ExpectedEvaluation | null;
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

/** Discriminates the two result shapes `buildRecord` accepts without either one needing to know
 *  about the other. */
export type AnyRunResult = FixtureRunResult | ModelRunResult;

export function isModelRunResult(result: AnyRunResult): result is ModelRunResult {
  return "kind" in result && result.kind === "model";
}

function votesFromModel(result: ModelRunResult): RecordVote[] {
  return result.votes.map((v) => ({
    fixtureName: result.fixtureName,
    agentId: v.agentId,
    voterAddress: v.voterAddress,
    proposalId: v.proposalId.toString(),
    support: v.support,
    vote: v.vote,
    onchainReason: v.onchainReason,
    jobState: v.jobState,
    txHash: v.txHash,
  }));
}

/** A model run's jobs come from the job store rather than from a per-agent vote result, so the
 *  `directive` column (a scripted fixture's script entry) has no meaning; it carries the provider
 *  and model the vote was produced with instead, which is the equivalent "what drove this job". */
function jobsFromModel(result: ModelRunResult): RecordJob[] {
  const agentByAddress = new Map(result.votes.map((v) => [v.voterAddress.toLowerCase(), v.agentId]));
  return result.jobs.map((job) => ({
    fixtureName: result.fixtureName,
    agentId: agentByAddress.get(job.agentAddress.toLowerCase()) ?? -1,
    directive: job.providerId && job.modelId ? `${job.providerId}:${job.modelId}` : "model",
    jobState: job.state,
    txHash: job.txHash,
    lastError: job.lastError,
  }));
}

function loopsFromModel(result: ModelRunResult): RecordLoop[] {
  return result.loops.map((loop) => ({
    fixtureName: result.fixtureName,
    agentId: loop.agentId,
    role: loop.role,
    provider: loop.provider,
    model: loop.model,
    isCoordinator: loop.isCoordinator,
    steps: loop.result?.steps ?? 0,
    blocked: loop.result?.blocked ?? 0,
    objections: loop.result?.objections ?? 0,
    testsPassed: loop.result?.testsPassed ?? false,
    proposed: (loop.result?.proposed ?? []).map((id) => id.toString()),
    stopReason: loop.result?.stopReason ?? null,
    error: loop.error,
  }));
}

const MISSING_VOTE_STATES: ReadonlySet<string> = new Set(["missed", "absent"]);

/**
 * Spec 15.5's per-run metrics, over either kind of result. Everything here is derived, never
 * asserted: a model run's `passCount` is how many fixtures matched their `expected` block, which
 * for a model fixture is the shape of the outcome rather than an exact chain state.
 *
 * `workerFailedTotal` counts jobs that produced no vote because the policy's own output could not
 * be used (spec 10.6). It is what the forced-malformed acceptance run is read from, and it is
 * deliberately counted apart from `missingVotesTotal`: a member that was absent or late is a
 * different failure from one whose model returned something unusable.
 */
function metricsFromResults(results: readonly AnyRunResult[]): Record<string, unknown> {
  const outcomeDistribution: Record<string, number> = {};
  let totalFeesWei = 0n;
  let missingVotesTotal = 0;
  let revertedAttemptsTotal = 0;
  let workerFailedTotal = 0;
  let refusedForOnMismatchTotal = 0;
  let proposalCount = 0;
  let stepCount = 0;
  let objectionCount = 0;
  let blockedCount = 0;
  let inferenceTokensTotal = 0;
  let inferenceCalls = 0;
  let inferenceUnknownUsageCalls = 0;
  let inferenceReportedCostUsd = 0;
  let inferenceUnknownCostCalls = 0;
  let inferenceAccountingIncomplete = false;
  let inferenceCallsDenied = 0;
  let inferenceBudgetRuns = 0;
  let inferenceChargedTokens = 0;
  let inferenceChargedCostUsd = 0;
  let inferenceReservationBreached = false;

  for (const r of results) {
    for (const fee of r.fees) totalFeesWei += BigInt(fee.feeWei);
    if (isModelRunResult(r)) {
      proposalCount += r.proposals.length;
      for (const p of r.proposals) {
        outcomeDistribution[p.finalStateName] = (outcomeDistribution[p.finalStateName] ?? 0) + 1;
      }
      for (const v of r.votes) {
        if (MISSING_VOTE_STATES.has(v.jobState)) missingVotesTotal += 1;
        if (v.jobState === "worker_failed") workerFailedTotal += 1;
        if (v.jobState === "refused_for_on_mismatch") refusedForOnMismatchTotal += 1;
      }
      if (r.inference) {
        inferenceTokensTotal += r.inference.inputTokens + r.inference.outputTokens;
        inferenceCalls += r.inference.callsStarted;
        inferenceUnknownUsageCalls += r.inference.unknownUsageCalls;
        inferenceReportedCostUsd += r.inference.reportedCostUsd;
        inferenceUnknownCostCalls += r.inference.unknownCostCalls;
        inferenceCallsDenied += r.inference.callsDenied;
        if (r.inference.budget) {
          inferenceBudgetRuns++;
          inferenceChargedTokens += r.inference.budget.chargedTokens;
          inferenceChargedCostUsd += r.inference.budget.chargedCostUsd;
          inferenceReservationBreached ||= r.inference.budget.reservationBreached;
        }
        inferenceAccountingIncomplete ||= r.inference.unknownUsageCalls > 0 || r.inference.unknownCostCalls > 0;
      } else {
        // Historical runs only counted vote usage. Preserve it, but label the missing coverage.
        inferenceAccountingIncomplete = true;
        for (const job of r.jobs) {
          const usage = job.usage;
          if (usage) {
            inferenceTokensTotal += (usage["inputTokens"] ?? 0) + (usage["outputTokens"] ?? 0);
            inferenceCalls += 1;
            inferenceUnknownCostCalls += 1;
          }
        }
      }
      stepCount += r.counts.steps;
      objectionCount += r.counts.objections;
      blockedCount += r.counts.blocked;
      continue;
    }
    outcomeDistribution[r.finalStateName] = (outcomeDistribution[r.finalStateName] ?? 0) + 1;
    proposalCount += 1;
    missingVotesTotal += r.missingVotes;
    if (r.impostor) {
      revertedAttemptsTotal += Number(r.impostor.proposeReverted) + Number(r.impostor.voteReverted);
    }
  }

  return {
    fixtureCount: results.length,
    passCount: results.filter((r) => r.pass).length,
    proposalCount,
    outcomeDistribution,
    missingVotesTotal,
    workerFailedTotal,
    refusedForOnMismatchTotal,
    revertedAttemptsTotal,
    stepCount,
    objectionCount,
    blockedCount,
    inferenceTokensTotal,
    inferenceCalls,
    inferenceUnknownUsageCalls,
    inferenceReportedCostUsd,
    inferenceUnknownCostCalls,
    inferenceAccountingIncomplete,
    inferenceCallsDenied,
    inferenceBudgetRuns,
    inferenceChargedTokens,
    inferenceChargedCostUsd,
    inferenceReservationBreached,
    totalFeesWei: totalFeesWei.toString(),
  };
}

/** The one task a record covers, or `null` when its results span more than one (`fleet demo`). */
function singleTaskId(results: readonly AnyRunResult[]): string | null {
  const ids = new Set(results.map((r) => r.taskId.toString()));
  if (ids.size !== 1) return null;
  return [...ids][0] ?? null;
}

/** Guardian actions taken through the Runner UI during this run (`interventions.jsonl`). Read from
 *  the run directory rather than passed in: the guardian route writes them from a different
 *  process than the one driving the run. */
function readInterventions(runDir: string | undefined): InterventionLineType[] {
  if (!runDir) return [];
  try {
    return readJsonl(path.join(runDir, RUN_FILES.interventions), InterventionLine);
  } catch {
    // A malformed interventions file must not cost the run its whole record.
    return [];
  }
}

/**
 * Assembles `record.json` (spec 12.4) from a completed set of runs, scripted or model driven:
 * `config`/`configHash`, the deployment `manifest`, the task, every chain event (block number,
 * block hash, tx hash, log index, decoded), the gateway allow/block log, every worker job, every
 * vote (`VoteV1` plus its onchain reason), timings, per-tx fees, derived metrics, and pinned
 * versions.
 *
 * A model run adds what the fleet itself did, which a scripted run has no equivalent of: the
 * coordinator's published steps, the members' objection outcomes, one entry per agent's task loop,
 * the fixture's rubric, and the evaluation of its `expected` block. Guardian actions taken through
 * the Runner UI are read from the run directory, since a different process wrote them.
 */
export async function buildRecord(opts: {
  client: FleetClient;
  runId: string;
  config: unknown;
  configHash: string;
  manifest: ManifestV1;
  results: readonly AnyRunResult[];
  timings: Record<string, unknown>;
  versions: Record<string, unknown>;
  /** `<reportDir>/<runId>`, so `humanInterventions` can be read off `interventions.jsonl`. */
  runDir?: string;
}): Promise<RunRecordDocument> {
  const events: RecordEvent[] = [];
  const gatewayLog: unknown[] = [];
  const jobs: RecordJob[] = [];
  const votes: RecordVote[] = [];
  const fees: FeeEntry[] = [];
  const proposals: RecordProposalRef[] = [];
  const steps: StepLineType[] = [];
  const objections: ObjectionLineType[] = [];
  const loops: RecordLoop[] = [];
  const rubric: string[] = [];
  let expected: ExpectedEvaluation | null = null;

  for (const result of opts.results) {
    if (isModelRunResult(result)) {
      for (const { trace } of result.traces) {
        events.push(
          ...(await attachBlockHashes(
            opts.client,
            result.fixtureName,
            trace.events as unknown as (Record<string, unknown> & { txHash: Hex })[],
          )),
        );
      }
      gatewayLog.push(...(result.gatewayLog as unknown[]));
      jobs.push(...jobsFromModel(result));
      votes.push(...votesFromModel(result));
      fees.push(...result.fees);
      steps.push(...result.steps);
      objections.push(...result.objections);
      loops.push(...loopsFromModel(result));
      rubric.push(...result.rubric);
      expected = result.expected;
      for (const p of result.proposals) {
        proposals.push({
          fixtureName: result.fixtureName,
          taskId: result.taskId.toString(),
          proposalId: p.proposalId.toString(),
          outcome: p.finalStateName,
          expectedOutcome: result.fixture.expected.outcome,
          pass: result.pass,
          kind: p.kind,
          payloadHash: p.payloadHash,
          proposerAgentId: p.proposerAgentId,
          summary: p.summary,
          ...(p.decision.action ? { action: p.decision.action } : {}),
          ...(p.decision.execution ? { execution: p.decision.execution } : {}),
        });
      }
      continue;
    }

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

  const execution = await captureExecutionRecord(opts.client, opts.manifest,
    opts.results.map(result => result.taskId.toString()),
    events.filter(event => event.type === "DecisionProposed").map(event => String(event.payloadHash)));
  if (execution) {
    const seen = new Set(fees.map(fee => fee.txHash.toLowerCase()));
    for (const event of execution.events) {
      if (!seen.has(event.txHash.toLowerCase())) {
        fees.push(await feeFromChain(opts.client, event.txHash as Hex));
        seen.add(event.txHash.toLowerCase());
      }
    }
  }
  return {
    schema: "fleet.record.v1",
    runId: opts.runId,
    config: opts.config,
    configHash: opts.configHash,
    manifest: opts.manifest,
    taskId: singleTaskId(opts.results),
    proposals,
    events,
    ...(execution ? { execution } : {}),
    gatewayLog,
    jobs,
    votes,
    steps,
    objections,
    humanInterventions: readInterventions(opts.runDir),
    loops,
    rubric,
    expected,
    timings: opts.timings,
    fees,
    metrics: { ...metricsFromResults(opts.results), totalFeesWei: fees.reduce((sum, fee) => sum + BigInt(fee.feeWei), 0n).toString() },
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
  discoverProposals: (client: FleetClient, taskId: bigint) => Promise<bigint[]> = listProposalIdsForTask,
): Promise<RunRecordDocument> {
  const events: RecordEvent[] = [];
  const votes: RecordVote[] = [];
  const fees: FeeEntry[] = [];
  const feeCache = new Set<string>();

  const proposals = await proposalsToRecapture(client, existing, discoverProposals);

  for (const ref of proposals) {
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

  const execution = await captureExecutionRecord(client, existing.manifest,
    [...proposals.map(ref => ref.taskId), ...(existing.taskId ? [existing.taskId] : [])],
    events.filter(event => event.type === "DecisionProposed").map(event => String(event.payloadHash)));
  for (const event of execution?.events ?? []) {
    if (!feeCache.has(event.txHash.toLowerCase())) {
      fees.push(await feeFromChain(client, event.txHash as Hex));
      feeCache.add(event.txHash.toLowerCase());
    }
  }
  const { execution: _previousExecution, ...base } = existing;
  return { ...base, proposals, events, votes, fees, ...(execution ? { execution } : {}) };
}


/**
 * Every `FleetHook.DecisionProposed` proposal id for one task, oldest first. This is how a model
 * run's proposals are found again: a scripted fixture's one proposal can be recomputed from its
 * trigger without touching the chain, but a model run's set is whatever the fleet decided to
 * propose, so the chain's own logs are the only record of it.
 */
export async function listProposalIdsForTask(client: FleetClient, taskId: bigint): Promise<bigint[]> {
  const logs = await client.publicClient.getContractEvents({
    address: client.addresses.hook as Address,
    abi: fleetHookAbi,
    eventName: "DecisionProposed",
    args: { taskId },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const ids: bigint[] = [];
  for (const entry of logs) {
    if (entry.args.proposalId === undefined) continue;
    if (!ids.includes(entry.args.proposalId)) ids.push(entry.args.proposalId);
  }
  return ids;
}

/** The `fixtureName` a rediscovered proposal belongs to: the one the record's own proposals carry
 *  when it has any, otherwise the fixture the config names. Never invented. */
function fixtureNameForRecord(existing: RunRecordDocument): string {
  const fromProposals = existing.proposals[0]?.fixtureName;
  if (fromProposals) return fromProposals;
  const config = existing.config;
  if (config && typeof config === "object" && "scenario" in config) {
    const scenario = (config as { scenario?: unknown }).scenario;
    if (scenario && typeof scenario === "object" && "fixture" in scenario) {
      const name = (scenario as { fixture?: unknown }).fixture;
      if (typeof name === "string") return name;
    }
  }
  return "";
}

/**
 * The proposals a re-capture should cover: the ones the record already lists, in their existing
 * order, plus any the chain knows about for the record's task that the record does not. The
 * existing ones keep their entries byte for byte, so a scripted run re-captures exactly as it did
 * before; a model run gains whatever a crashed or partial run failed to write down, with its
 * outcome read from chain rather than assumed.
 */
async function proposalsToRecapture(
  client: FleetClient,
  existing: RunRecordDocument,
  discoverProposals: (client: FleetClient, taskId: bigint) => Promise<bigint[]>,
): Promise<RecordProposalRef[]> {
  const proposals = [...existing.proposals];
  if (existing.taskId === null) return proposals;

  let discovered: bigint[];
  try {
    discovered = await discoverProposals(client, BigInt(existing.taskId));
  } catch {
    // A log query that fails leaves the record's own list as the best available answer.
    return proposals;
  }

  const known = new Set(proposals.map((p) => p.proposalId));
  const expectedOutcome = existing.proposals[0]?.expectedOutcome ?? "any";
  for (const proposalId of discovered) {
    if (known.has(proposalId.toString())) continue;
    let outcome = "unknown";
    try {
      outcome = ProposalState[await client.getProposalState(proposalId)] ?? "unknown";
    } catch {
      // Leave it named but with an unknown outcome rather than dropping a real proposal.
    }
    proposals.push({
      fixtureName: fixtureNameForRecord(existing),
      taskId: existing.taskId,
      proposalId: proposalId.toString(),
      outcome,
      expectedOutcome,
      pass: false,
    });
  }
  return proposals;
}
