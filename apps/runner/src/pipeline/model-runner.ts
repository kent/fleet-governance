import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setMaxListeners } from "node:events";
import { cp } from "node:fs/promises";
import path from "node:path";
import { createWalletClient, defineChain, http, publicActions } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { InferenceLimits, RuntimeLimits } from "@fleet/schemas";
import type { ActionDescriptor, DecisionKind, DecisionV1, ModelFixtureV1, VoteV1 } from "@fleet/schemas";
import { fleetHookAbi } from "@fleet/abi";
import {
  FleetSigner,
  Keeper,
  MemoryNonceStore,
  NonceManager,
  ProposalState,
  getDecisionTrace,
  parseDecisionDescription,
  WorkPool,
  mapConcurrent,
} from "@fleet/sdk";
import type { DecisionTrace, FleetAddresses, FleetClient, SignerPolicy } from "@fleet/sdk";
import {
  MemoryJobStore,
  ModelPolicy,
  PgJobStore,
  StepBoard,
  TaskLoop,
  ToolRouter,
  DockerPackageInstaller,
  Workspace,
  Worker,
  decisionToProposeInput,
  forceMalformedProvider,
  pickCoordinator,
  InferenceScheduler,
  assertOpenRouterBudgetKey,
} from "@fleet/agent-runtime";
import type { InferenceSummary } from "@fleet/agent-runtime";
import { ClaudeCliProvider, OpenRouterProvider, readOpenRouterApiKey } from "@fleet/agent-runtime";
import type { JobRecord, JobState, Provider, RecordedDecision, TaskLoopEvent, TaskLoopResult } from "@fleet/agent-runtime";
import { LedgerWatcher, evaluateAction } from "@fleet/gateway";
import type { GatewayLogRecord, GatewayVerdict } from "@fleet/gateway";
import { RunnerEnvError } from "../env.js";
import { withRunConstitution } from "./constitution.js";
import { insertVoteRow, syncCplsAfterStage, waitForDaoNode } from "./cpls-sync.js";
import type { FetchLike } from "./cpls-sync.js";
import type { FeeEntry, FleetKeys, ReadSideSyncConfig } from "./fixture-runner.js";
import { withHostOverrides } from "./host-overrides.js";
import type { HostOverrides } from "./host-overrides.js";
import { evaluateModelExpected } from "./model-expected.js";
import type { ExpectedEvaluation } from "./model-expected.js";
import { RUN_FILES, appendJsonl, readJsonl } from "./runfiles.js";
import { GatewayLogLine, ObjectionLine, StepLine } from "./runfiles.js";
import type { GatewayLogLineType, LoopEventLineType, ObjectionLineType, StepLineType } from "./runfiles.js";
import { openInferenceJournal } from "./inference-journal.js";
import { artifactPublisher } from "./artifact-publication.js";

/** How long a fake host gets to print `listening <port>` before the run gives up on it. */
const HOST_READY_TIMEOUT_MS = 10_000;

/** How long followers get to notice a closed board after the coordinator stops, before the run's
 *  `AbortController` fires. A follower is normally woken immediately by `board.close()`; this
 *  covers one that is mid-inference. */
const FOLLOWER_GRACE_MS = 30_000;

/** Default wall-clock ceiling for the whole model run, overridable with
 *  `FLEET_MODEL_RUN_TIMEOUT_MS`. Twenty minutes: long enough for five real models to work a task,
 *  short enough that a wedged run does not hold a CI machine forever. */
export const DEFAULT_MODEL_RUN_TIMEOUT_MS = 1_200_000;

/** Seconds of slack past the governance clock before settlement gives up waiting for a proposal
 *  to reach a terminal state. */
const SETTLEMENT_SLACK_SEC = 60;

const KEEPER_POLL_MS = 3000;
const PROPOSAL_STATE_POLL_MS = 2000;

const TERMINAL_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set([
  ProposalState.Executed,
  ProposalState.Defeated,
  ProposalState.Canceled,
  ProposalState.Expired,
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One fleet member as the experiment config describes it, the only part of `ExperimentConfigV1`
 *  a model run needs. Declared structurally so this module does not depend on the whole config. */
export type ModelRunMember = { role: string; provider: "scripted" | "claude-cli" | "openrouter"; model: string; promptVersion: string };

export type ModelLoopResult = {
  agentId: number;
  role: string;
  provider: string;
  model: string;
  isCoordinator: boolean;
  result: TaskLoopResult | null;
  /** Set when the loop threw rather than returning a result; the run still finishes and reports it. */
  error: string | null;
};

export type ModelProposalRef = {
  proposalId: bigint;
  kind: DecisionKind;
  payloadHash: Hex;
  proposerAgentId: number;
  summary: string;
  finalState: ProposalState;
  finalStateName: string;
  proposeTxHash: Hex;
  description: string;
  decision: DecisionV1;
};

export type ModelVoteResult = {
  agentId: number;
  voterAddress: Address;
  proposalId: bigint;
  support: 0 | 1 | 2 | null;
  weight: string | null;
  onchainReason: string | null;
  jobState: JobState;
  vote: VoteV1 | null;
  txHash: Hex | null;
  lastError: string | null;
};

export type ModelRunResult = {
  kind: "model";
  fixture: ModelFixtureV1;
  fixtureName: string;
  taskId: bigint;
  proposals: ModelProposalRef[];
  traces: { proposalId: bigint; trace: DecisionTrace }[];
  votes: ModelVoteResult[];
  jobs: JobRecord[];
  loops: ModelLoopResult[];
  steps: StepLineType[];
  objections: ObjectionLineType[];
  gatewayLog: GatewayLogLineType[];
  counts: { steps: number; objections: number; blocked: number };
  testsPassed: Record<number, boolean>;
  fees: FeeEntry[];
  expected: ExpectedEvaluation;
  rubric: string[];
  forcedMalformedAgents: number[];
  inference?: InferenceSummary;
  pass: boolean;
  mismatches: string[];
  timings: { startedAt: string; loopsEndedAt: string; finishedAt: string };
};

export type ModelRunContext = {
  client: FleetClient;
  rpcUrl: string;
  chainId: number;
  addresses: FleetAddresses;
  keys: FleetKeys;
  members: readonly ModelRunMember[];
  /** Governance timing from the deployment manifest, used to bound settlement. */
  governance: { votingDelay: number; votingPeriod: number; timelockDelay: number };
  /** `<reportDir>/<runId>`: where the JSON-lines feeds and the per-agent workspaces live. */
  runDir: string;
  /** Repository root, for resolving a fixture's repo, overlay, and host-site paths. */
  repoRoot: string;
  feeLimits?: { maxFeePerGasWei?: bigint; maxGas?: bigint };
  inference?: InferenceLimits;
  constitution?: string;
  runtime?: RuntimeLimits;
  submissionMarginSec: number;
  env: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  onProposalKnown?: (proposalId: bigint, txHash: Hex) => Promise<void> | void;
  readSideSync?: ReadSideSyncConfig;
  /**
   * Builds the `Provider` for one member. Present only in tests, which drive the whole pipeline
   * with `ScriptedProvider`s: a `scripted` member has no real adapter behind it, so without a
   * factory the run refuses to start rather than silently inventing one.
   */
  providerFactory?: (agentId: number, member: ModelRunMember) => Provider;
  /** Injected only by tests that do not want real child processes; production spawns `node`. */
  spawnHost?: (args: string[]) => ChildProcess;
};

// ---------------------------------------------------------------------------------------------
// fake hosts
// ---------------------------------------------------------------------------------------------

type RunningHosts = { overrides: HostOverrides; stop: () => Promise<void> };

/** `experiments/fixtures/hosts/examples-internal/server.mjs`, the one fake host implementation
 *  every model fixture's `hosts[]` entry names a site of. */
export function hostServerPath(repoRoot: string): string {
  return path.join(repoRoot, "experiments", "fixtures", "hosts", "examples-internal", "server.mjs");
}

export function hostSitePath(repoRoot: string, site: string): string {
  return path.join(repoRoot, "experiments", "fixtures", "hosts", "examples-internal", "sites", site);
}

/**
 * Starts one loopback HTTP server per fixture host and returns the name-to-origin map the tool
 * router's `fetch` wrapper uses. Each is spawned as `node server.mjs --site <site> --port <port>`
 * with an argv array, never a shell string, so a site or port from a fixture file cannot become a
 * second command.
 *
 * Readiness is the server's own first stderr line (`listening <port>`), not a sleep: a model's
 * first fetch can arrive immediately after the loops start, and a race there would read as a
 * network failure rather than as the charter verdict the fixture is about.
 */
async function startHosts(
  fixture: ModelFixtureV1,
  repoRoot: string,
  log: (m: string) => void,
  spawnHost?: (args: string[]) => ChildProcess,
): Promise<RunningHosts> {
  const children: ChildProcess[] = [];
  const overrides: HostOverrides = {};

  const stop = async (): Promise<void> => {
    for (const child of children) {
      child.kill("SIGTERM");
    }
  };

  try {
    for (const host of fixture.hosts) {
      const args = [hostServerPath(repoRoot), "--site", host.site, "--port", String(host.port)];
      const child = spawnHost ? spawnHost(args) : spawn("node", args, { stdio: ["ignore", "ignore", "pipe"] });
      children.push(child);
      await waitForHostReady(child, host.name, host.port);
      overrides[host.name] = `http://127.0.0.1:${host.port}`;
      log(`model run: host ${host.name} -> http://127.0.0.1:${host.port} (site ${host.site})`);
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return { overrides, stop };
}

function waitForHostReady(child: ChildProcess, name: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => {
      reject(new RunnerEnvError(`fake host ${name} did not report "listening ${port}" within ${HOST_READY_TIMEOUT_MS}ms; stderr so far: ${seen.trim()}`));
    }, HOST_READY_TIMEOUT_MS);
    const done = (err?: Error): void => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      seen += chunk.toString();
      if (seen.includes(`listening ${port}`)) done();
    });
    child.on("error", (err) => done(err instanceof Error ? err : new Error(String(err))));
    child.on("exit", (code) => done(new RunnerEnvError(`fake host ${name} exited early (code ${String(code)}); stderr: ${seen.trim()}`)));
  });
}

// ---------------------------------------------------------------------------------------------
// per-agent wiring
// ---------------------------------------------------------------------------------------------

function signerPolicy(ctx: ModelRunContext): SignerPolicy {
  return {
    chainId: ctx.chainId,
    governor: ctx.addresses.governor,
    ledger: ctx.addresses.ledger,
    token: ctx.addresses.token,
    ...(ctx.addresses.executor ? { executor: ctx.addresses.executor } : {}),
    ...(ctx.feeLimits?.maxFeePerGasWei !== undefined ? { maxFeePerGasWei: ctx.feeLimits.maxFeePerGasWei } : {}),
    ...(ctx.feeLimits?.maxGas !== undefined ? { maxGas: ctx.feeLimits.maxGas } : {}),
  };
}

function newSigner(ctx: ModelRunContext, key: Hex): { signer: FleetSigner; nonces: NonceManager } {
  const nonces = new NonceManager(new MemoryNonceStore(), ctx.rpcUrl);
  return { signer: new FleetSigner({ privateKey: key, rpcUrl: ctx.rpcUrl, policy: signerPolicy(ctx), nonces }), nonces };
}

/** Same shape `fixture-runner.ts` builds for the keeper: a raw viem wallet, since the keeper is
 *  not a fleet member and never goes through `FleetSigner`. */
function buildKeeperWallet(ctx: ModelRunContext) {
  const chain = defineChain({
    id: ctx.chainId,
    name: `fleet-runner-${ctx.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [ctx.rpcUrl] } },
  });
  return createWalletClient({ account: privateKeyToAccount(ctx.keys.keeperKey), chain, transport: http(ctx.rpcUrl) }).extend(
    publicActions,
  );
}

/** The agent ids named in `FLEET_FORCE_MALFORMED_AGENTS`, an acceptance-run test knob (task 7
 *  controller notes): the listed agents' vote provider is wrapped so every inference fails as
 *  malformed, which must produce a `worker_failed` job and no vote, never a For and never a
 *  synthesized Abstain (spec 10.6). Not a production setting; nothing sets it by default. */
export function parseForcedMalformedAgents(env: NodeJS.ProcessEnv): number[] {
  const raw = env["FLEET_FORCE_MALFORMED_AGENTS"];
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((id) => Number.isInteger(id) && id >= 0);
}

function buildProvider(ctx: ModelRunContext, agentId: number, member: ModelRunMember): Provider {
  if (ctx.providerFactory) return ctx.providerFactory(agentId, member);
  switch (member.provider) {
    case "openrouter":
      return new OpenRouterProvider({ apiKey: readOpenRouterApiKey(ctx.env), model: member.model, maxAttempts: 1 });
    case "claude-cli":
      return new ClaudeCliProvider({ model: member.model });
    case "scripted":
      // A scripted member has no adapter of its own: `ScriptedProvider` needs a responder, which
      // only a test can supply. Refused rather than quietly substituted, so a model run can never
      // claim to have driven models it did not.
      throw new RunnerEnvError(
        `agent ${agentId} is configured with provider "scripted", which a model-driven run can only use through an injected provider factory (tests). Configure "openrouter" or "claude-cli" for a real run.`,
      );
  }
}

type AgentRig = {
  agentId: number;
  role: string;
  member: ModelRunMember;
  workspace: Workspace;
  router: ToolRouter;
  provider: Provider;
  signer: FleetSigner;
  nonces: NonceManager;
  worker: Worker;
  loop: TaskLoop;
  isCoordinator: boolean;
  forcedMalformed: boolean;
};

// ---------------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------------

/**
 * Runs one model-driven fixture end to end on `taskId` (task 7 controller notes).
 *
 * Unlike `runFixture`, nothing here scripts what the fleet does. This function builds the world
 * the fleet works in (fake hosts on loopback, a private workspace per agent, a charter gateway per
 * agent, a provider per member), starts one `TaskLoop` per agent against one shared `StepBoard`,
 * and then does the deterministic half of the job: turning whatever divergence the fleet produces
 * into proposals, running a `Worker` per agent per proposal so every member votes with its own
 * public reason, keeping a keeper reconciling queue and execute, and writing every observable to
 * the run directory's JSON-lines feeds as it happens.
 *
 * Which proposals exist, how many, and whether any exist at all is the fleet's business. A run in
 * which the fleet never diverged is a real result, reported as one.
 */
export async function runModelFixture(
  ctx: ModelRunContext,
  fixture: ModelFixtureV1,
  taskId: bigint,
): Promise<ModelRunResult> {
  assertModelInferenceBudget(ctx.members, ctx.inference, Boolean(ctx.providerFactory));
  if (!ctx.providerFactory && ctx.members.some(member => member.provider === "openrouter")) {
    await assertOpenRouterBudgetKey(readOpenRouterApiKey(ctx.env), ctx.inference!.budget!.maxCostUsd, fetch, ctx.inference!.budget!.providerCreditPoolUsd);
  }
  const journal = openInferenceJournal(path.join(ctx.runDir, RUN_FILES.inference), `${ctx.chainId}:${ctx.addresses.ledger.toLowerCase()}:${taskId}`);
  try { return await runModelFixtureOwned(ctx, fixture, taskId, journal); }
  finally { journal.close(); }
}

export function assertModelInferenceBudget(members: readonly ModelRunMember[], inference: InferenceLimits | undefined, hasTestProvider = false): void {
  const limits = InferenceLimits.parse(inference ?? {});
  if (!hasTestProvider && members.some(member => member.provider !== "scripted")) {
    if (!limits.budget) throw new RunnerEnvError("model runs require an explicit inference.budget with token, dollar and model-price limits");
    for (const member of members) {
      if (member.provider !== "openrouter") throw new RunnerEnvError("budgeted live inference currently requires OpenRouter; the Claude CLI cannot enforce output and price reservations");
      if (!limits.budget.prices[member.model]) throw new RunnerEnvError(`inference.budget.prices is missing ${member.model}`);
    }
  }
}

async function runModelFixtureOwned(ctx: ModelRunContext, fixture: ModelFixtureV1, taskId: bigint, journal: ReturnType<typeof openInferenceJournal>): Promise<ModelRunResult> {
  const startedAt = new Date().toISOString();
  const log = ctx.log ?? ((): void => {});
  log(`model fixture ${fixture.name}: starting on task ${taskId.toString()}`);

  const gatewayPath = path.join(ctx.runDir, RUN_FILES.gateway);
  const stepsPath = path.join(ctx.runDir, RUN_FILES.steps);
  const objectionsPath = path.join(ctx.runDir, RUN_FILES.objections);
  const loopEventsPath = path.join(ctx.runDir, RUN_FILES.loopEvents);
  const inferenceLimits = InferenceLimits.parse(ctx.inference ?? {});
  const runtimeLimits = RuntimeLimits.parse(ctx.runtime ?? {});
  const toolPool = new WorkPool(runtimeLimits.toolConcurrency);
  const votePool = new WorkPool(runtimeLimits.voteConcurrency);
  const inference = new InferenceScheduler({
    ...inferenceLimits,
    history: journal.history,
    journal: event => journal.append(event),
    charterTokenLimit: async () => {
      const task = await ctx.client.getTask(taskId);
      if (!task.charter) throw new Error("task charter unavailable");
      return task.charter.budget.inferenceTokens;
    },
  });

  let hosts: RunningHosts | undefined;
  const rigs: AgentRig[] = [];
  const jobStore = ctx.env["RUNNER_PG_URL"] ? new PgJobStore(ctx.env["RUNNER_PG_URL"]) : new MemoryJobStore();
  const controller = new AbortController();
  setMaxListeners(ctx.members.length + 2, controller.signal);
  try {
  const runningHosts = await startHosts(fixture, ctx.repoRoot, log, ctx.spawnHost);
  hosts = runningHosts;
  if (jobStore instanceof PgJobStore) await jobStore.migrate();

  const forcedAgents = parseForcedMalformedAgents(ctx.env);
  const registryMembers = await ctx.client.listMembers();
  const roleFor = (agentId: number): string => {
    const member = registryMembers.find((m) => m.agentId === agentId);
    if (member) {
      try {
        const parsed: unknown = JSON.parse(member.manifest);
        if (parsed && typeof parsed === "object" && "role" in parsed && typeof (parsed as { role: unknown }).role === "string") {
          return (parsed as { role: string }).role;
        }
      } catch {
        // fall through to the experiment config's own role
      }
    }
    return ctx.members[agentId]?.role ?? "agent";
  };

  const coordinatorAgentId = pickCoordinator(
    ctx.members.map((_member, agentId) => ({ agentId, role: roleFor(agentId) })),
    fixture.coordinatorRole,
  );
  log(`model fixture ${fixture.name}: coordinator is agent ${coordinatorAgentId} (role "${roleFor(coordinatorAgentId)}", fixture asked for "${fixture.coordinatorRole}")`);

  const board = new StepBoard();

  // Everything the run learns about proposals, votes and steps as it happens. Filled in by the
  // loop callbacks and the settlement phase alike, so a run that is cut short by the deadline
  // still reports what it did before the cut.
  const proposalOrder: bigint[] = [];
  const proposalInfo = new Map<string, { proposerAgentId: number; decision: DecisionV1; txHash: Hex; description: string }>();
  let lastProposalAtMs = 0;

  const keeperWallet = buildKeeperWallet(ctx);
  const keeper = new Keeper({
    client: ctx.client,
    wallet: keeperWallet,
    addresses: ctx.addresses,
    ...(ctx.feeLimits ? { feeLimits: ctx.feeLimits } : {}),
  });

  const syncStage = async (proposalId: bigint, label: string): Promise<void> => {
    await syncReadSide(ctx, proposalId, label);
  };

  /** Called once per proposal the fleet makes: records it, checkpoints it, syncs the read side,
   *  then drives every agent's vote and, from there on, the keeper's own loop picks it up. */
  const registerProposal = async (proposalId: bigint, txHash: Hex, proposerAgentId: number, decision: DecisionV1): Promise<void> => {
    const key = proposalId.toString();
    if (proposalInfo.has(key)) return;
    const description = decisionToProposeInput(decision, roleFor(proposerAgentId)).description;
    proposalInfo.set(key, { proposerAgentId, decision, txHash, description });
    proposalOrder.push(proposalId);
    lastProposalAtMs = Date.now();
    log(`model fixture ${fixture.name}: agent ${proposerAgentId} proposed ${key} (${decision.kind}, tx ${txHash})`);
    if (ctx.onProposalKnown) await ctx.onProposalKnown(proposalId, txHash);
    try {
      await ctx.client.publicClient.waitForTransactionReceipt({ hash: txHash });
    } catch (err) {
      log(`model fixture ${fixture.name}: could not confirm propose tx ${txHash}: ${errorMessage(err)}`);
    }
    if (ctx.readSideSync) {
      await waitForDaoNodeProposal(ctx, proposalId);
      await syncStage(proposalId, "proposed");
    }
    // Deliberately not awaited: the proposing agent's loop must keep working while the fleet
    // votes. Failures are logged inside `driveVotes`, never thrown into the loop.
    void driveVotes(proposalId);
  };

  const votingDriven = new Map<string, Promise<void>>();
  const driveVotes = (proposalId: bigint): Promise<void> => {
    const key = proposalId.toString();
    const existing = votingDriven.get(key);
    if (existing) return existing;
    const running = (async () => {
    try {
      const became = await waitForActive(ctx, proposalId, controller.signal);
      if (!became) {
        log(`model fixture ${fixture.name}: proposal ${key} never became Active; no votes were driven`);
        return;
      }
      // In parallel, not one after another: each agent has its own signer and nonce manager, and
      // five sequential 60 second inferences would not fit inside a realistic voting period.
      await mapConcurrent(rigs, runtimeLimits.voteConcurrency, async (rig) => {
          try {
            const job = await votePool.run(() => rig.worker.handleProposal(proposalId));
            log(`model fixture ${fixture.name}: agent ${rig.agentId} job on ${key} -> ${job.state}${job.lastError ? ` (${job.lastError})` : ""}`);
          } catch (err) {
            log(`model fixture ${fixture.name}: agent ${rig.agentId} worker on ${key} threw: ${errorMessage(err)}`);
          }
        });
      if (ctx.readSideSync) {
        await insertVoteRowsFromChain(ctx, proposalId);
        await syncStage(proposalId, "voted");
      }
    } catch (err) {
      log(`model fixture ${fixture.name}: driving votes for ${key} failed: ${errorMessage(err)}`);
    }
    })();
    votingDriven.set(key, running);
    return running;
  };

    for (let agentId = 0; agentId < ctx.members.length; agentId++) {
      const member = ctx.members[agentId]!;
      const key = ctx.keys.agentKeys[agentId];
      if (!key) throw new RunnerEnvError(`model fixture ${fixture.name}: no key configured for agent ${agentId}`);

      const workspace = await Workspace.fromFixture(
        path.resolve(ctx.repoRoot, fixture.repoFixture),
        agentId,
        path.join(ctx.runDir, "workspaces"),
      );
      if (fixture.repoOverlay) {
        // The overlay is copied over the fixture repo after it lands, so an overlay file replaces
        // the repo's own (that is how `injection-in-task-data` swaps in a poisoned README).
        await cp(path.resolve(ctx.repoRoot, fixture.repoOverlay), workspace.dir, { recursive: true, force: true });
      }

      const { signer, nonces } = newSigner(ctx, key);
      const watcher = new LedgerWatcher(ctx.client, taskId, (message, err) => log(`${message}: ${errorMessage(err)}`));
      const router = new ToolRouter({
        workspace,
        watcher,
        agentId,
        budget: { toolCalls: 0 },
        log: (record: GatewayLogRecord) => appendJsonl(gatewayPath, record),
        fetchImpl: withHostOverrides(fetch, runningHosts.overrides),
        artifactPublisher: artifactPublisher(ctx.client, signer),
        packageInstaller: new DockerPackageInstaller(),
      });

      const rawProvider = withRunConstitution(buildProvider(ctx, agentId, member), ctx.constitution);
      const provider = inference.wrap(rawProvider, { agentId, model: member.model, purpose: "task" }, controller.signal);
      const forcedMalformed = forcedAgents.includes(agentId);
      // Only the vote provider is forced. The agent keeps working the task normally; what the knob
      // demonstrates is that unusable model output cannot become a ballot.
      const votingProvider = forcedMalformed ? forceMalformedProvider(rawProvider, agentId)
        : inference.wrap(rawProvider, { agentId, model: member.model, purpose: "vote" });
      if (forcedMalformed) log(`model fixture ${fixture.name}: agent ${agentId}'s vote provider is forced to malformed (FLEET_FORCE_MALFORMED_AGENTS)`);

      const registryMember = registryMembers.find((m) => m.account.toLowerCase() === signer.address.toLowerCase());
      if (!registryMember) {
        throw new RunnerEnvError(
          `model fixture ${fixture.name}: FLEET_AGENT_KEY_${agentId} is not a registered fleet member on this deployment`,
        );
      }

      const worker = new Worker({
        // Final review I4: the registry decides which agent id an address is, so the worker is
        // built with the id this key actually maps to, not the loop index.
        agentId: registryMember.agentId,
        signer,
        client: ctx.client,
        policy: new ModelPolicy({ provider: votingProvider, promptVersion: member.promptVersion, timeoutMs: inferenceLimits.requestTimeoutMs }),
        jobs: jobStore,
        nonces,
        submissionMarginSec: ctx.submissionMarginSec,
        pollMs: KEEPER_POLL_MS,
      });

      const role = roleFor(agentId);
      const loop = new TaskLoop({
        agentId,
        role,
        provider,
        timeoutMs: inferenceLimits.requestTimeoutMs,
        inferenceAvailable: () => inference.canStartTask(),
        tools: {
          call: (tc) => toolPool.run(() => router.call(tc, controller.signal), controller.signal).catch(error => ({ ok: false as const, error: errorMessage(error) })),
          usage: () => router.usage(),
          listFiles: () => workspace.listFiles(),
        },
        board,
        isCoordinator: agentId === coordinatorAgentId,
        task: () => ctx.client.getTask(taskId),
        propose: async (decision: DecisionV1) => {
          const { txHash, proposalId } = await signer.propose(decisionToProposeInput(decision, role));
          await registerProposal(proposalId, txHash, agentId, decision);
          return proposalId;
        },
        decisions: async (): Promise<RecordedDecision[]> => {
          const decisions = await ctx.client.listDecisions(taskId);
          return decisions.map((d) => ({ kind: d.kind, payloadHash: d.payloadHash, charterVersion: d.charterVersionAfter }));
        },
        objections: {
          record: (o): void => {
            const line: ObjectionLineType = {
              type: "objection",
              at: new Date().toISOString(),
              agentId: o.agentId,
              seq: o.step.seq,
              objects: o.objects,
              alternative: o.alternative ? { class: o.alternative.class, target: o.alternative.target, args: o.alternative.args } : null,
              why: o.why,
              proposalId: o.proposalId === null ? null : o.proposalId.toString(),
            };
            appendJsonl(objectionsPath, line);
          },
        },
        log: (event: TaskLoopEvent): void => {
          const loopEventLine: LoopEventLineType = { type: "loop_event", at: new Date().toISOString(), agentId, event };
          appendJsonl(loopEventsPath, loopEventLine);
          if (event.type === "step_published") {
            const line: StepLineType = {
              type: "step",
              at: new Date().toISOString(),
              agentId: event.agentId,
              seq: event.seq,
              tool: { class: event.tool.class, target: event.tool.target, args: event.tool.args },
              why: event.why,
              source: event.source,
            };
            appendJsonl(stepsPath, line);
          }
        },
        maxSteps: fixture.maxSteps,
        blockedBackoffMs: readBackoffMs(ctx.env),
      });

      rigs.push({
        agentId,
        role,
        member,
        workspace,
        router,
        provider,
        signer,
        nonces,
        worker,
        loop,
        isCoordinator: agentId === coordinatorAgentId,
        forcedMalformed,
      });
    }

    // A resumed run rediscovers whatever the earlier process already proposed, so the keeper and
    // the workers pick those up instead of the fleet proposing them a second time.
    await rediscoverProposals(ctx, taskId, registerProposal, log);

    const deadlineMs = await runDeadlineMs(ctx, taskId);
    log(`model fixture ${fixture.name}: run deadline ${Math.round(deadlineMs / 1000)}s`);
    const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);

    const stopKeeper = startKeeperLoop(ctx, keeper, () => [...proposalOrder], syncStage, log);

    const loopResults = new Map<number, TaskLoopResult>();
    const loopErrors = new Map<number, string>();
    let followerTimer: NodeJS.Timeout | null = null;

    const running = rigs.map(async (rig) => {
      try {
        loopResults.set(rig.agentId, await rig.loop.run(controller.signal));
      } catch (err) {
        loopErrors.set(rig.agentId, errorMessage(err));
        log(`model fixture ${fixture.name}: agent ${rig.agentId}'s loop threw: ${errorMessage(err)}`);
      } finally {
        if (rig.isCoordinator) {
          // Followers block on `board.waitForNext`; closing wakes every one of them with null.
          // The timer covers a follower that is mid-inference and therefore not waiting.
          board.close();
          followerTimer = setTimeout(() => controller.abort(), FOLLOWER_GRACE_MS);
        }
      }
    });

    await Promise.allSettled(running);
    if (followerTimer) clearTimeout(followerTimer);
    clearTimeout(deadlineTimer);
    const loopsEndedAt = new Date().toISOString();
    log(`model fixture ${fixture.name}: every loop stopped; settling ${proposalOrder.length} proposal(s)`);

    await settle(ctx, proposalOrder, () => lastProposalAtMs, driveVotes, log);
    await Promise.allSettled([...votingDriven.values()]);
    stopKeeper();
    await inference.close();

    const result = await assembleResult({
      ctx,
      fixture,
      taskId,
      rigs,
      jobStore,
      proposalOrder,
      proposalInfo,
      loopResults,
      loopErrors,
      forcedAgents,
      gatewayPath,
      stepsPath,
      objectionsPath,
      startedAt,
      loopsEndedAt,
    });
    const summary = inference.summary();
    if (summary.budget?.reservationBreached) {
      result.pass = false;
      result.mismatches.push("provider reported usage above its inference reservation; further inference was stopped");
    }
    return { ...result, inference: summary };
  } finally {
    controller.abort();
    const drained = await Promise.allSettled([inference.close(), toolPool.close(), votePool.close()]);
    // Run resource cleanup even if a journal or pool failed while draining. Tool work has
    // settled before its installer's dependency volume is removed.
    const cleanup = [...drained, ...await Promise.allSettled(rigs.map(rig => rig.router.close())),
      ...await Promise.allSettled([hosts?.stop(), jobStore instanceof PgJobStore ? jobStore.close() : undefined])];
    const failed = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), "model run cleanup failed");
  }
}

/** `FLEET_LOOP_BACKOFF_MS`: how long a loop pauses after a blocked, locally refused, or failed
 *  iteration. Defaults to the task loop's own 2 seconds; the integration test sets 0 so a scripted
 *  run does not spend wall-clock time it has no use for. */
function readBackoffMs(env: NodeJS.ProcessEnv): number {
  const raw = env["FLEET_LOOP_BACKOFF_MS"];
  if (raw === undefined || raw.trim() === "") return 2000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
}

/** The smaller of what is left of the task's own lifetime and `FLEET_MODEL_RUN_TIMEOUT_MS`. The
 *  task's expiry is the real bound: past it the gateway blocks every call, so a fleet still
 *  running then can only burn budget. */
async function runDeadlineMs(ctx: ModelRunContext, taskId: bigint): Promise<number> {
  const configured = Number(ctx.env["FLEET_MODEL_RUN_TIMEOUT_MS"] ?? "");
  const ceiling = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MODEL_RUN_TIMEOUT_MS;
  try {
    const [task, now] = await Promise.all([ctx.client.getTask(taskId), ctx.client.timestamp()]);
    const remainingMs = Number(task.expiresAt - now) * 1000;
    if (remainingMs > 0) return Math.min(ceiling, remainingMs);
  } catch {
    // An unreadable task is the loops' problem (they stop on a task they cannot read); the
    // configured ceiling still bounds the run.
  }
  return ceiling;
}

/**
 * Every proposal already on chain for this task, so a resumed `AGENTS_RUNNING` picks up what an
 * earlier process proposed rather than starting from nothing. A model run has no deterministic
 * trigger to recompute (that is what `findExistingProposal` does for a scripted fixture), so the
 * chain's own `DecisionProposed` logs are the only record of what was proposed.
 */
async function rediscoverProposals(
  ctx: ModelRunContext,
  taskId: bigint,
  register: (proposalId: bigint, txHash: Hex, proposerAgentId: number, decision: DecisionV1) => Promise<void>,
  log: (m: string) => void,
): Promise<void> {
  let found: { proposalId: bigint; proposer: Address; txHash: Hex }[];
  try {
    found = await listDecisionProposedForTask(ctx, taskId);
  } catch (err) {
    log(`model run: could not list existing proposals for task ${taskId.toString()}: ${errorMessage(err)}`);
    return;
  }
  if (found.length === 0) return;
  const members = await ctx.client.listMembers();
  for (const entry of found) {
    const member = members.find((m) => m.account.toLowerCase() === entry.proposer.toLowerCase());
    const created = await ctx.client.getProposalCreated(entry.proposalId);
    const decision = decisionFromDescription(created.description);
    if (!decision) {
      log(`model run: proposal ${entry.proposalId.toString()} exists but its description does not decode; it is still tracked for settlement`);
    }
    log(`model run: resuming with existing proposal ${entry.proposalId.toString()} from agent ${member?.agentId ?? -1}`);
    await register(entry.proposalId, entry.txHash, member?.agentId ?? -1, decision ?? placeholderDecision(taskId, entry.proposalId));
  }
}

/** The decision behind an existing proposal, read from its own description through the SDK's
 *  parser. A description that does not decode is still a real proposal on chain; it just has no
 *  decoded body to report. */
function decisionFromDescription(description: string): DecisionV1 | null {
  try {
    return parseDecisionDescription(description).decision;
  } catch {
    return null;
  }
}

function placeholderDecision(taskId: bigint, proposalId: bigint): DecisionV1 {
  return {
    schema: "fleet.decision.v1",
    taskId: taskId.toString(),
    kind: "ESCALATE_TO_HUMAN",
    expectedVersion: 1,
    payloadHash: `0x${"00".repeat(32)}`,
    proposerAgentId: 0,
    summary: `proposal ${proposalId.toString()} (description did not decode)`,
    rationale: "The proposal exists on chain but its description could not be decoded on resume.",
    assumptions: [],
    riskFlags: [],
  };
}

async function listDecisionProposedForTask(
  ctx: ModelRunContext,
  taskId: bigint,
): Promise<{ proposalId: bigint; proposer: Address; txHash: Hex }[]> {
  const logs = await ctx.client.publicClient.getContractEvents({
    address: ctx.addresses.hook,
    abi: fleetHookAbi,
    eventName: "DecisionProposed",
    args: { taskId },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const out: { proposalId: bigint; proposer: Address; txHash: Hex }[] = [];
  for (const entry of logs) {
    if (entry.args.proposalId === undefined) continue;
    out.push({
      proposalId: entry.args.proposalId,
      proposer: (entry.args.proposer ?? "0x0000000000000000000000000000000000000000") as Address,
      txHash: entry.transactionHash,
    });
  }
  return out;
}

/** Polls until the proposal is Active (so a worker's submission-window check can pass), or until
 *  it has left the voting window altogether, or the run aborts. */
async function waitForActive(ctx: ModelRunContext, proposalId: bigint, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    if (signal.aborted) return false;
    let state: ProposalState;
    try {
      state = await ctx.client.getProposalState(proposalId);
    } catch {
      await sleep(PROPOSAL_STATE_POLL_MS);
      continue;
    }
    if (state === ProposalState.Active) return true;
    if (state !== ProposalState.Pending) return false;
    await sleep(PROPOSAL_STATE_POLL_MS);
  }
}

/** Queues and executes on its own clock, over whatever proposals the run knows about so far.
 *  Returns a stop function. Errors are logged and retried on the next tick: a keeper that throws
 *  out of its interval would take the process with it. */
function startKeeperLoop(
  ctx: ModelRunContext,
  keeper: Keeper,
  proposalIds: () => bigint[],
  syncStage: (proposalId: bigint, label: string) => Promise<void>,
  log: (m: string) => void,
): () => void {
  let stopped = false;
  const settledIds = new Set<string>();

  const tick = async (): Promise<void> => {
    for (const proposalId of proposalIds()) {
      if (stopped) return;
      const key = proposalId.toString();
      if (settledIds.has(key)) continue;
      try {
        const result = await keeper.reconcileProposal(proposalId);
        if (result === "queued") log(`model run: keeper queued proposal ${key}`);
        if (result === "executed" || result === "defeated" || result === "canceled") {
          settledIds.add(key);
          log(`model run: keeper sees proposal ${key} terminal (${result})`);
        }
        // One sync per state change the keeper actually observed, not one per branch it matched.
        if (result !== "noop" && result !== "waiting" && ctx.readSideSync) await syncStage(proposalId, result);
      } catch (err) {
        log(`model run: keeper tick for ${key} failed: ${errorMessage(err)}`);
      }
    }
  };

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, KEEPER_POLL_MS);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Keeps the workers and the keeper going after the loops stop, until every proposal the run knows
 * about is terminal or the governance clock has had time to settle them (task 7 controller notes:
 * `votingDelay + votingPeriod + timelockDelay + 60` seconds since the last proposal).
 *
 * This is where a run that proposed in its last step still ends with a real outcome rather than an
 * Active proposal and an empty tally.
 */
async function settle(
  ctx: ModelRunContext,
  proposalIds: readonly bigint[],
  lastProposalAtMs: () => number,
  driveVotes: (proposalId: bigint) => Promise<void>,
  log: (m: string) => void,
): Promise<void> {
  if (proposalIds.length === 0) return;
  const windowMs =
    (ctx.governance.votingDelay + ctx.governance.votingPeriod + ctx.governance.timelockDelay + SETTLEMENT_SLACK_SEC) * 1000;

  // A proposal made in the loops' last moments may not have been voted on yet; the settlement
  // phase still owes it the fleet's votes.
  await Promise.allSettled(proposalIds.map((id) => driveVotes(id)));

  for (;;) {
    const states = await Promise.all(
      proposalIds.map(async (id) => {
        try {
          return await ctx.client.getProposalState(id);
        } catch {
          return ProposalState.Pending;
        }
      }),
    );
    if (states.every((s) => TERMINAL_PROPOSAL_STATES.has(s))) {
      log(`model run: every proposal reached a terminal state`);
      return;
    }
    if (Date.now() - lastProposalAtMs() > windowMs) {
      log(
        `model run: settlement window of ${Math.round(windowMs / 1000)}s elapsed with ${states.filter((s) => !TERMINAL_PROPOSAL_STATES.has(s)).length} proposal(s) still unsettled`,
      );
      return;
    }
    await sleep(KEEPER_POLL_MS);
  }
}

// ---------------------------------------------------------------------------------------------
// read side
// ---------------------------------------------------------------------------------------------

function readSideFetch(sync: ReadSideSyncConfig): FetchLike {
  return sync.fetchFn ?? ((url, init) => fetch(url, init as never) as unknown as ReturnType<FetchLike>);
}

async function waitForDaoNodeProposal(ctx: ModelRunContext, proposalId: bigint): Promise<void> {
  const sync = ctx.readSideSync;
  if (!sync) return;
  await waitForDaoNode(
    readSideFetch(sync),
    `${sync.daoNodeUrl}/v1/proposal/${proposalId.toString()}`,
    (body) => (body as { proposal?: { id?: string } })?.proposal?.id === proposalId.toString(),
    { description: `DAO Node to index proposal ${proposalId.toString()}` },
  );
}

async function syncReadSide(ctx: ModelRunContext, proposalId: bigint, label: string): Promise<void> {
  const sync = ctx.readSideSync;
  if (!sync) return;
  const log = ctx.log ?? ((): void => {});
  try {
    await syncCplsAfterStage(readSideFetch(sync), {
      cplsUrl: sync.cplsUrl,
      identity: { governor: ctx.addresses.governor, chainId: ctx.chainId },
      archive: { offline: sync.offline, bucketName: sync.bucketName, ...(sync.fakeGcsUrl ? { fakeGcsUrl: sync.fakeGcsUrl } : {}) },
      proposalId: proposalId.toString(),
      label,
      log,
    });
  } catch (err) {
    // The read side is a viewer, not the source of truth. A sync failure is reported, never fatal
    // to a run whose chain state is already correct.
    log(`model run: CPLS sync after "${label}" for proposal ${proposalId.toString()} failed: ${errorMessage(err)}`);
  }
}

async function insertVoteRowsFromChain(ctx: ModelRunContext, proposalId: bigint): Promise<void> {
  const sync = ctx.readSideSync;
  if (!sync) return;
  const log = ctx.log ?? ((): void => {});
  try {
    const trace = await getDecisionTrace(ctx.client, proposalId);
    for (const event of trace.events) {
      if (event.type !== "VoteCast") continue;
      await insertVoteRow(sync.votesPool, {
        proposalId: proposalId.toString(),
        transactionHash: event.txHash,
        blockNumber: event.blockNumber,
        chainId: ctx.chainId,
        voter: event.voter,
        support: event.support,
        weight: event.weight,
        reason: event.reason,
        contract: ctx.addresses.governor,
      });
    }
  } catch (err) {
    log(`model run: inserting fleet.votes rows for proposal ${proposalId.toString()} failed: ${errorMessage(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// result assembly
// ---------------------------------------------------------------------------------------------

async function assembleResult(args: {
  ctx: ModelRunContext;
  fixture: ModelFixtureV1;
  taskId: bigint;
  rigs: readonly AgentRig[];
  jobStore: MemoryJobStore | PgJobStore;
  proposalOrder: readonly bigint[];
  proposalInfo: Map<string, { proposerAgentId: number; decision: DecisionV1; txHash: Hex; description: string }>;
  loopResults: Map<number, TaskLoopResult>;
  loopErrors: Map<number, string>;
  forcedAgents: readonly number[];
  gatewayPath: string;
  stepsPath: string;
  objectionsPath: string;
  startedAt: string;
  loopsEndedAt: string;
}): Promise<ModelRunResult> {
  const { ctx, fixture, taskId } = args;
  const log = ctx.log ?? ((): void => {});

  const gatewayLog = readJsonl(args.gatewayPath, GatewayLogLine);
  const steps = readJsonl(args.stepsPath, StepLine);
  const objections = readJsonl(args.objectionsPath, ObjectionLine);

  const proposals: ModelProposalRef[] = [];
  const traces: { proposalId: bigint; trace: DecisionTrace }[] = [];
  for (const proposalId of args.proposalOrder) {
    const info = args.proposalInfo.get(proposalId.toString());
    if (!info) continue;
    let finalState = ProposalState.Pending;
    try {
      finalState = await ctx.client.getProposalState(proposalId);
    } catch (err) {
      log(`model run: could not read the final state of proposal ${proposalId.toString()}: ${errorMessage(err)}`);
    }
    proposals.push({
      proposalId,
      kind: info.decision.kind,
      payloadHash: info.decision.payloadHash as Hex,
      proposerAgentId: info.proposerAgentId,
      summary: info.decision.summary,
      finalState,
      finalStateName: ProposalState[finalState] as string,
      proposeTxHash: info.txHash,
      description: info.description,
      decision: info.decision,
    });
    try {
      traces.push({ proposalId, trace: await getDecisionTrace(ctx.client, proposalId) });
    } catch (err) {
      log(`model run: could not read the decision trace for proposal ${proposalId.toString()}: ${errorMessage(err)}`);
    }
  }

  const jobs = await args.jobStore.list({ chainId: ctx.chainId, governor: ctx.addresses.governor });
  const jobByAgentAndProposal = new Map<string, JobRecord>();
  for (const job of jobs) jobByAgentAndProposal.set(`${job.agentAddress.toLowerCase()}|${job.proposalId}`, job);

  const votes: ModelVoteResult[] = [];
  for (const { proposalId, trace } of traces) {
    const casts = trace.events.filter((e): e is Extract<typeof e, { type: "VoteCast" }> => e.type === "VoteCast");
    for (const rig of args.rigs) {
      const job = jobByAgentAndProposal.get(`${rig.signer.address.toLowerCase()}|${proposalId.toString()}`);
      const cast = casts.find((c) => c.voter.toLowerCase() === rig.signer.address.toLowerCase());
      votes.push({
        agentId: rig.agentId,
        voterAddress: rig.signer.address,
        proposalId,
        support: cast?.support ?? null,
        weight: cast ? cast.weight.toString() : null,
        onchainReason: cast?.reason ?? null,
        jobState: job?.state ?? "absent",
        vote: job?.vote ?? null,
        txHash: job?.txHash ?? null,
        lastError: job?.lastError ?? null,
      });
    }
  }

  const loops: ModelLoopResult[] = args.rigs.map((rig) => ({
    agentId: rig.agentId,
    role: rig.role,
    provider: rig.member.provider,
    model: rig.member.model,
    isCoordinator: rig.isCoordinator,
    result: args.loopResults.get(rig.agentId) ?? null,
    error: args.loopErrors.get(rig.agentId) ?? null,
  }));

  const counts = loops.reduce(
    (acc, l) => ({
      steps: acc.steps + (l.result?.steps ?? 0),
      objections: acc.objections + (l.result?.objections ?? 0),
      blocked: acc.blocked + (l.result?.blocked ?? 0),
    }),
    { steps: 0, objections: 0, blocked: 0 },
  );
  const testsPassed: Record<number, boolean> = {};
  for (const l of loops) testsPassed[l.agentId] = l.result?.testsPassed ?? false;

  // Every proposal transaction, plus every vote, queue and execute transaction, which the decision
  // trace already lists.
  const txHashes: Hex[] = [
    ...proposals.map((p) => p.proposeTxHash),
    ...traces.flatMap(({ trace }) => trace.events.map((e) => e.txHash)),
  ];
  const fees = await computeFees(ctx, txHashes);

  const expected = await evaluateModelExpected({
    expected: fixture.expected,
    hostNames: fixture.hosts.map((h) => h.name),
    proposalStates: proposals.map((p) => p.finalStateName),
    gatewayLog,
    recheck: (descriptor) => recheckDescriptor(ctx, taskId, descriptor),
  });

  const mismatches = expected.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

  return {
    kind: "model",
    fixture,
    fixtureName: fixture.name,
    taskId,
    proposals,
    traces,
    votes,
    jobs,
    loops,
    steps,
    objections,
    gatewayLog,
    counts,
    testsPassed,
    fees,
    expected,
    rubric: fixture.rubric,
    forcedMalformedAgents: [...args.forcedAgents],
    pass: expected.pass,
    mismatches,
    timings: { startedAt: args.startedAt, loopsEndedAt: args.loopsEndedAt, finishedAt: new Date().toISOString() },
  };
}

/** Re-evaluates one descriptor against the ledger as it stands now, through the same
 *  `evaluateAction` the gateway used during the run, with a fresh snapshot. `usage.toolCalls` is 0
 *  so a run that exhausted its budget does not report every descriptor as blocked for that reason
 *  rather than for the charter's own answer. */
async function recheckDescriptor(ctx: ModelRunContext, taskId: bigint, descriptor: ActionDescriptor): Promise<GatewayVerdict> {
  const watcher = new LedgerWatcher(ctx.client, taskId, () => {});
  const snapshot = await watcher.snapshot();
  return evaluateAction(snapshot, descriptor, { toolCalls: 0 });
}

async function computeFees(ctx: ModelRunContext, txHashes: readonly Hex[]): Promise<FeeEntry[]> {
  const unique = [...new Set(txHashes.map((h) => h.toLowerCase()))] as Hex[];
  const fees: FeeEntry[] = [];
  for (const hash of unique) {
    try {
      const receipt = await ctx.client.publicClient.getTransactionReceipt({ hash });
      const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
      fees.push({
        txHash: hash,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: effectiveGasPrice.toString(),
        feeWei: (receipt.gasUsed * effectiveGasPrice).toString(),
      });
    } catch {
      // A hash with no receipt (a send that never landed) is left out rather than recorded with
      // invented values.
    }
  }
  return fees;
}
