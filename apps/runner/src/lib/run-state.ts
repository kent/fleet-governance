import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { Address } from "viem";
import type { CharterV1 as CharterV1Type, ManifestV1 as ManifestV1Type } from "@fleet/schemas";
import pg from "pg";
import type { RunRecordDocument } from "../pipeline/record.js";
import { captureExecutionRecord } from "../pipeline/execution-record.js";
import type { ExecutionRecord } from "../pipeline/execution-record.js";
import { GatewayLogLine, InterventionLine, RUN_FILES, StepLine, readJsonl } from "../pipeline/runfiles.js";
import type { GatewayLogLineType, InterventionLineType, StepLineType } from "../pipeline/runfiles.js";
import { readEnvValue } from "../readside.js";
import { getDecisionTrace } from "@fleet/sdk";
import { buildFleetClientFromManifest, listTaskProposalIds } from "./chain.js";
import { agoraProposalUrl } from "./links.js";
import { loadRunnerEnv } from "./env.js";
import { repoRoot } from "./paths.js";
import { resolveRunContext } from "./run-context.js";
import { openRunStoreSafe } from "./safe-stores.js";
import type { HealthView } from "./health.js";
import { probeHealth } from "./health.js";

/** The read surface `run-state.ts` needs from a chain client: structurally satisfied by a real
 *  `@fleet/sdk` `FleetClient` (production, via `buildFleetClientFromManifest`) or a hand-built fake
 *  (tests: "state route with injected chain client returning canned data", task 6 controller
 *  notes). */
export type RunStateChainClient = {
  chainId: number;
  addresses: { governor: Address; hook: Address };
  publicClient: {
    getBlockNumber(): Promise<bigint>;
    getBalance(args: { address: Address }): Promise<bigint>;
  };
  getTask(taskId: bigint): Promise<{ charterVersion: number; charterText: string; charter: CharterV1Type | null }>;
  getProposalState(proposalId: bigint): Promise<number>;
  getProposalVotes(proposalId: bigint): Promise<{ against: bigint; for: bigint; abstain: bigint }>;
  listVotes(proposalId: bigint): Promise<{ voter: Address; support: 0 | 1 | 2; reason: string }[]>;
  getProposalCreated(proposalId: bigint): Promise<{ description: string }>;
};

/** Mirrors `@fleet/sdk`'s `ProposalState` enum names (0..7), so a view model never has to import
 *  the SDK's runtime enum just to render a number as a name. */
const PROPOSAL_STATE_NAMES = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];

export type ProposalVoteView = { voter: string; agentId: number | null; support: 0 | 1 | 2 | null; reason: string | null };
export type ProposalView = {
  proposalId: string;
  taskId: string;
  kind: string | null;
  status: string;
  rawDescription: string;
  tally: { forTokens: string; againstTokens: string; abstainTokens: string; forMembers: number; againstMembers: number; abstainMembers: number };
  votes: ProposalVoteView[];
  agoraLink: string | null;
  /** Where this proposal's data came from: a live chain read, or `record.json` when the chain was
   *  unreachable (task 6 controller notes: routes degrade to "no gateway log yet"-style fallbacks
   *  rather than failing the whole view). */
  source: "chain" | "record";
};

export type AgentView = {
  agentId: number;
  address: string | null;
  role: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  lastStep: StepLineType | null;
  lastGatewayDecision: GatewayLogLineType | null;
  jobState: string;
};

export type CharterView = { source: "chain" | "config" | "none"; version: number | null; text: string; parsed: CharterV1Type | null };

/** A `DecisionTraceEvent` (or a `record.json` `RecordEvent`) with every `bigint` already turned
 *  into a decimal string, ready for `Timeline` (task 6 controller notes: "Timeline merging chain
 *  events and gateway decisions by block number and log index"). */
export type ChainEventView = Record<string, unknown> & { type: string; blockNumber: string; logIndex: number; txHash: string };

export type RunStateView = {
  runId: string;
  stage: string | null;
  stageUpdatedAt: string | null;
  experimentName: string | null;
  taskId: string | null;
  charter: CharterView;
  proposals: ProposalView[];
  chainEvents: ChainEventView[];
  execution: (ExecutionRecord & { source: "chain" | "record" }) | null;
  gatewayRecords: GatewayLogLineType[];
  agents: AgentView[];
  health: HealthView;
  interventions: InterventionLineType[];
  agoraNextBaseUrl: string | null;
  chain: { reachable: boolean; detail: string | null };
};

export type RunStateDeps = {
  repoRootDir: string;
  env: NodeJS.ProcessEnv;
  buildClient: (manifest: ManifestV1Type, rpcUrl: string) => RunStateChainClient;
  listProposalIds: (client: RunStateChainClient, taskId: bigint, fromBlock: bigint) => Promise<bigint[]>;
  /** `getDecisionTrace(client, proposalId)` (task 6 controller notes), kept separately injectable
   *  from `buildClient` since the real `@fleet/sdk` function needs a concrete `FleetClient`, wider
   *  than the narrow `RunStateChainClient` surface a test's canned client satisfies. */
  listDecisionEvents: (client: RunStateChainClient, proposalId: bigint) => Promise<ChainEventView[]>;
  readExecution?: (client: RunStateChainClient, manifest: ManifestV1Type, taskIds: string[], payloadHashes: string[]) => Promise<ExecutionRecord | undefined>;
};

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function defaultRunStateDeps(): RunStateDeps {
  loadRunnerEnv();
  return {
    repoRootDir: repoRoot,
    env: process.env,
    buildClient: (manifest, rpcUrl) => buildFleetClientFromManifest(manifest, rpcUrl),
    listProposalIds: (client, taskId, fromBlock) => listTaskProposalIds(client as never, taskId, fromBlock),
    listDecisionEvents: async (client, proposalId) => {
      const trace = await getDecisionTrace(client as never, proposalId);
      return trace.events.map((event) => JSON.parse(JSON.stringify(event, bigintReplacer)) as ChainEventView);
    },
    readExecution: (client, manifest, taskIds, payloadHashes) => captureExecutionRecord(client as never, manifest, taskIds, payloadHashes),
  };
}

function readFileIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

type ParsedAgentManifest = { role?: string; provider?: string; model?: string; promptVersion?: string };

function tryParseAgentManifest(raw: string | undefined): ParsedAgentManifest | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ParsedAgentManifest;
  } catch {
    return null;
  }
}

function stringField(payload: Record<string, unknown> | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function proposalViewFromChain(
  client: RunStateChainClient,
  taskId: bigint,
  proposalId: bigint,
  members: readonly Address[],
  agoraNextBaseUrl: string | undefined,
  kind: string | null,
): Promise<ProposalView> {
  return Promise.all([
    client.getProposalState(proposalId),
    client.getProposalVotes(proposalId),
    client.listVotes(proposalId),
    client.getProposalCreated(proposalId),
  ]).then(([state, tally, ballots, created]) => {
    const votes: ProposalVoteView[] = ballots.map((v) => ({
      voter: v.voter,
      agentId: memberIndex(members, v.voter),
      support: v.support,
      reason: v.reason || null,
    }));
    const memberCounts = { forMembers: 0, againstMembers: 0, abstainMembers: 0 };
    for (const v of ballots) {
      if (v.support === 1) memberCounts.forMembers += 1;
      else if (v.support === 0) memberCounts.againstMembers += 1;
      else if (v.support === 2) memberCounts.abstainMembers += 1;
    }
    return {
      proposalId: proposalId.toString(),
      taskId: taskId.toString(),
      // Fix round 1, F2: correlated from this same proposal's `DecisionProposed` event (the
      // caller already fetched it via `listDecisionEvents`), not hardcoded. Stays `null` only when
      // that event has not been indexed yet; `ProposalCard` renders that as "kind not yet indexed".
      kind,
      status: PROPOSAL_STATE_NAMES[state] ?? `unknown(${state})`,
      rawDescription: created.description,
      tally: {
        forTokens: tally.for.toString(),
        againstTokens: tally.against.toString(),
        abstainTokens: tally.abstain.toString(),
        ...memberCounts,
      },
      votes,
      agoraLink: agoraProposalUrl(agoraNextBaseUrl, proposalId.toString()),
      source: "chain",
    };
  });
}

function memberIndex(members: readonly Address[], address: Address): number | null {
  const index = members.findIndex((m) => m.toLowerCase() === address.toLowerCase());
  return index === -1 ? null : index;
}

function proposalViewFromRecord(record: RunRecordDocument, proposalId: string, agoraNextBaseUrl: string | undefined): ProposalView {
  const ref = record.proposals.find((p) => p.proposalId === proposalId);
  const decisionProposed = record.events.find((e) => e["type"] === "DecisionProposed" && e["proposalId"] === proposalId) as
    | { kind?: string }
    | undefined;
  const proposalCreated = record.events.find((e) => e["type"] === "ProposalCreated" && e["proposalId"] === proposalId) as
    | { description?: string }
    | undefined;
  const votes = record.votes.filter((v) => v.proposalId === proposalId);
  const tally = { forTokens: "0", againstTokens: "0", abstainTokens: "0", forMembers: 0, againstMembers: 0, abstainMembers: 0 };
  for (const v of votes) {
    if (v.support === 1) tally.forMembers += 1;
    else if (v.support === 0) tally.againstMembers += 1;
    else if (v.support === 2) tally.abstainMembers += 1;
  }
  // A saved ballot's member count is not its token weight: delegation can move voting power.
  // Read actual weights from VoteCast events and report missing evidence as unknown.
  const casts = record.events.filter(event => event.type === "VoteCast" && String(event.proposalId) === proposalId);
  const weights = [0n, 0n, 0n];
  const voters = new Set<string>();
  let complete = true;
  for (const event of casts) {
    const support = Number(event.support);
    const weight = String(event.weight ?? "");
    if (![0, 1, 2].includes(support) || !/^[0-9]+$/.test(weight) || typeof event.voter !== "string") {
      complete = false;
      continue;
    }
    if (voters.has(event.voter.toLowerCase())) { complete = false; continue; }
    voters.add(event.voter.toLowerCase());
    weights[support] = weights[support]! + BigInt(weight);
  }
  if (votes.some(vote => vote.support !== null && !voters.has(vote.voterAddress.toLowerCase()))) complete = false;
  tally.againstTokens = complete ? weights[0]!.toString() : "unknown";
  tally.forTokens = complete ? weights[1]!.toString() : "unknown";
  tally.abstainTokens = complete ? weights[2]!.toString() : "unknown";
  return {
    proposalId,
    taskId: ref?.taskId ?? "0",
    kind: decisionProposed?.kind ?? null,
    status: ref?.outcome ?? "unknown",
    rawDescription: proposalCreated?.description ?? "",
    tally,
    votes: votes.map((v) => ({ voter: v.voterAddress, agentId: v.agentId, support: v.support, reason: v.onchainReason })),
    agoraLink: agoraProposalUrl(agoraNextBaseUrl, proposalId),
    source: "record",
  };
}

/**
 * Assembles the whole `GET /api/runs/[id]/state` view model (task 6 controller notes: "stage,
 * charter and version, proposals with trace-derived fields, agents, health, interventions").
 * Layers, per panel, from the most authoritative source it can reach down to the most durable:
 * live chain reads (via `deps.buildClient`) first, `record.json` when the chain is unreachable,
 * and a plain "not available yet" fallback when neither exists.
 */
export async function buildRunState(runId: string, deps: RunStateDeps = defaultRunStateDeps()): Promise<RunStateView> {
  const { runDir, experiment, deployConfig, record, manifest } = await resolveRunContext(runId, deps.repoRootDir, deps.env["RUNNER_PG_URL"]);

  const pipelineStore = await openRunStoreSafe({ pgUrl: deps.env["RUNNER_PG_URL"], runDir });
  const stageRecord = await pipelineStore.get(runId);
  const payload = stageRecord?.payload;

  const taskIdString = stringField(payload, "taskId") ?? record?.proposals[0]?.taskId ?? null;
  const taskId = taskIdString ? BigInt(taskIdString) : null;

  let client: RunStateChainClient | null = null;
  let chainReachable = false;
  let chainDetail: string | null = null;
  if (manifest && experiment) {
    try {
      client = deps.buildClient(manifest, experiment.target.rpcHttp);
      await client.publicClient.getBlockNumber();
      chainReachable = true;
    } catch (err) {
      client = null;
      chainReachable = false;
      chainDetail = err instanceof Error ? err.message : String(err);
    }
  }

  let proposalIds: string[] = [];
  const directProposalId = stringField(payload, "proposalId") ?? stringField(payload, "proposalIdInProgress");
  if (record) {
    proposalIds = record.proposals.map((p) => p.proposalId);
  } else if (directProposalId) {
    proposalIds = [directProposalId];
  } else if (client && taskId !== null && manifest) {
    try {
      const ids = await deps.listProposalIds(client, taskId, BigInt(manifest.deploymentBlock));
      proposalIds = ids.map((id) => id.toString());
    } catch {
      proposalIds = [];
    }
  }

  const members: readonly Address[] = (manifest?.members ?? []) as readonly Address[];
  const proposals: ProposalView[] = [];
  const chainEvents: ChainEventView[] = [];
  for (const proposalId of proposalIds) {
    const proposalTaskId = record?.proposals.find(ref => ref.proposalId === proposalId)?.taskId;
    const currentTaskId = proposalTaskId ? BigInt(proposalTaskId) : taskId;
    // Fix round 1, F2: fetch this proposal's trace events first, so its `DecisionProposed.kind`
    // is available to pass into `proposalViewFromChain` rather than hardcoding `kind: null`.
    // Independent of whether the proposal card itself ends up sourced from chain or record.json: a
    // failure listing this one proposal's trace events should not discard events already gathered
    // for others, nor a proposal view that otherwise succeeded.
    let proposalEvents: ChainEventView[] = [];
    if (client && currentTaskId !== null) {
      try {
        proposalEvents = await deps.listDecisionEvents(client, BigInt(proposalId));
      } catch {
        // the record.json-wide fallback below covers this when nothing could be listed live
      }
    }
    const kindFromChain =
      (proposalEvents.find((e) => e["type"] === "DecisionProposed") as { kind?: string } | undefined)?.kind ?? null;

    let pushedFromChain = false;
    if (client && currentTaskId !== null) {
      try {
        proposals.push(
          await proposalViewFromChain(client, currentTaskId, BigInt(proposalId), members, experiment?.display.agoraNextBaseUrl, kindFromChain),
        );
        pushedFromChain = true;
      } catch {
        // fall through to the record.json fallback below
      }
    }
    if (!pushedFromChain && record) {
      proposals.push(proposalViewFromRecord(record, proposalId, experiment?.display.agoraNextBaseUrl));
    }
    chainEvents.push(...proposalEvents);
  }
  if (chainEvents.length === 0 && record) {
    chainEvents.push(...(record.events as unknown as ChainEventView[]));
  }

  let execution: RunStateView["execution"] = record?.execution ? { ...record.execution, source: "record" } : null;
  if (client && manifest && deps.readExecution) {
    try {
      const captured = await deps.readExecution(client, manifest,
        [...proposals.map(proposal => proposal.taskId), ...(taskIdString ? [taskIdString] : [])],
        chainEvents.filter(event => event.type === "DecisionProposed").map(event => String(event.payloadHash)));
      if (captured) execution = { ...JSON.parse(JSON.stringify(captured, bigintReplacer)) as ExecutionRecord, source: "chain" };
    } catch {
      // Keep the explicitly labeled saved snapshot if the execution resource cannot be read.
    }
  }

  const charter: CharterView = await (async () => {
    if (client && taskId !== null) {
      try {
        const task = await client.getTask(taskId);
        return { source: "chain" as const, version: task.charterVersion, text: task.charterText, parsed: task.charter };
      } catch {
        // fall through to the config fallback
      }
    }
    if (experiment) {
      return { source: "config" as const, version: null, text: JSON.stringify(experiment.task.charter, null, 2), parsed: experiment.task.charter };
    }
    return { source: "none" as const, version: null, text: "", parsed: null };
  })();

  const stepsPath = path.join(runDir, RUN_FILES.steps);
  const gatewayPath = path.join(runDir, RUN_FILES.gateway);
  const steps = readJsonl(stepsPath, StepLine);
  const gatewayLines = readJsonl(gatewayPath, GatewayLogLine);
  const interventions = readJsonl(path.join(runDir, RUN_FILES.interventions), InterventionLine);

  // Queried directly with `pg`, deliberately not through `@fleet/agent-runtime`'s `PgJobStore`:
  // that package's index.ts barrel also exports its Docker sandbox and worker modules, which
  // `next build`'s page-data collection step evaluates eagerly and which do not survive being
  // bundled (see the task 6 report's Deviations, same reasoning `ConfigForm.tsx`'s comment gives
  // for avoiding the same package from the browser bundle). The `jobs` table shape mirrors
  // `packages/agent-runtime/src/migrations/001_jobs.sql` exactly.
  const pgUrl = deps.env["RUNNER_PG_URL"];
  const jobStates = new Map<string, string>();
  let jobsReadFailed = false;
  if (pgUrl && manifest) {
    const jobsPool = new pg.Pool({ connectionString: pgUrl });
    try {
      const result = await jobsPool.query<{ agent_address: string; state: string }>(
        "SELECT DISTINCT ON (agent_address) agent_address, state FROM jobs WHERE chain_id = $1 AND governor = $2 ORDER BY agent_address, updated_at DESC",
        [manifest.chainId, manifest.addresses.governor.toLowerCase()],
      );
      for (const row of result.rows) jobStates.set(row.agent_address.toLowerCase(), row.state);
    } catch { jobsReadFailed = true; }
    finally { await jobsPool.end(); }
  }
  const lastSteps = new Map(steps.map(step => [step.agentId, step]));
  const lastGatewayDecisions = new Map(gatewayLines.map(line => [line.agentId, line]));
  const savedJobs = new Map((record?.jobs ?? []).map(job => [job.agentId, job.jobState]));

  const memberCount = manifest?.members.length ?? experiment?.fleet.members.length ?? 0;
  const agents: AgentView[] = [];
  for (let agentId = 0; agentId < memberCount; agentId++) {
    const address = manifest?.members[agentId] ?? null;
    const parsedManifest = tryParseAgentManifest(deployConfig?.agentManifests[agentId]);
    const configuredMember = experiment?.fleet.members[agentId];
    const lastStep = lastSteps.get(agentId) ?? null;
    const lastGatewayDecision = lastGatewayDecisions.get(agentId) ?? null;

    const jobState = pgUrl && manifest && address
      ? jobsReadFailed ? "could not read job state" : jobStates.get(address.toLowerCase()) ?? "no job yet"
      : savedJobs.get(agentId) ?? "not tracked (no database)";

    agents.push({
      agentId,
      address,
      role: parsedManifest?.role ?? configuredMember?.role ?? null,
      provider: parsedManifest?.provider ?? configuredMember?.provider ?? null,
      model: parsedManifest?.model ?? configuredMember?.model ?? null,
      promptVersion: parsedManifest?.promptVersion ?? configuredMember?.promptVersion ?? null,
      lastStep,
      lastGatewayDecision,
      jobState,
    });
  }

  const infraEnvText = readFileIfExists(path.join(deps.repoRootDir, "infra", ".env")) ?? "";
  const daoNodeUrl = `http://localhost:${readEnvValue(infraEnvText, "DAO_NODE_PORT", "8000")}`;
  const cplsUrl = `http://localhost:${readEnvValue(infraEnvText, "CPLS_PORT", "8001")}`;
  const logText = readFileIfExists(path.join(runDir, RUN_FILES.log)) ?? "";

  const signers: { label: string; address: Address }[] = [];
  if (manifest) {
    signers.push(
      { label: "operator", address: manifest.operator as Address },
      { label: "guardian", address: manifest.guardian as Address },
    );
    manifest.members.forEach((address, agentId) => signers.push({ label: `agent${agentId}`, address: address as Address }));
  }

  const health = await probeHealth({
    daoNodeUrl,
    cplsUrl,
    agoraNextUrl: experiment?.display.agoraNextBaseUrl ?? null,
    getChainHead: async () => {
      if (!client) throw new Error("chain not reachable");
      return client.publicClient.getBlockNumber();
    },
    getBalanceWei: async (address) => {
      if (!client) throw new Error("chain not reachable");
      return client.publicClient.getBalance({ address });
    },
    signers,
    logText,
  });

  return {
    runId,
    stage: stageRecord?.stage ?? null,
    stageUpdatedAt: stageRecord?.updatedAt ?? null,
    experimentName: experiment?.name ?? stringField(payload, "experimentName"),
    taskId: taskIdString,
    charter,
    proposals,
    chainEvents,
    execution,
    gatewayRecords: gatewayLines,
    agents,
    health,
    interventions,
    agoraNextBaseUrl: experiment?.display.agoraNextBaseUrl ?? null,
    chain: { reachable: chainReachable, detail: chainDetail },
  };
}
