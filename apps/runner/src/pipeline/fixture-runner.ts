import {
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  publicActions,
  toHex,
} from "viem";
import type { Address, Hex, WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agoraGovernorAbi, taskLedgerAbi, timelockControllerAbi } from "@fleet/abi";
import { canonicalize } from "@fleet/schemas";
import type { ActionClass, CharterV1, DecisionV1, FixtureV1, VoteV1 } from "@fleet/schemas";
import {
  FleetClient,
  FleetSigner,
  Keeper,
  MemoryNonceStore,
  NonceManager,
  ProposalState,
  buildDecisionDescription,
  encodeRecordDecision,
  explainRevert,
  getDecisionTrace,
  payloadHashForAction,
  payloadHashForCharter,
} from "@fleet/sdk";
import type { DecisionTrace, FleetAddresses, SignerPolicy } from "@fleet/sdk";
import { MemoryJobStore, ScriptedPolicy, Worker } from "@fleet/agent-runtime";
import type { JobState } from "@fleet/agent-runtime";
import { describeAction } from "@fleet/gateway";
import type { GatewayLogRecord } from "@fleet/gateway";
import { checkGateway } from "./gateway-check.js";
import { insertVoteRow, syncCplsAfterStage, waitForDaoNode } from "./cpls-sync.js";
import type { FetchLike, QueryablePool } from "./cpls-sync.js";
import { ZERO_BYTES32, timelockSalt } from "./timelock.js";

export type FleetKeys = {
  deployerKey: Hex;
  operatorKey: Hex;
  guardianKey: Hex;
  keeperKey: Hex;
  agentKeys: Record<number, Hex>;
};

/** Everything `runFixture` needs to sync the read side after each governance transaction (task 8
 *  finding 3). `votesPool` must be connected to the `agora_web3` database (CPLS's own vote
 *  source, `fleet.votes`; see `cpls-sync.ts`'s `insertVoteRow`). */
export type ReadSideSyncConfig = {
  votesPool: QueryablePool;
  daoNodeUrl: string;
  cplsUrl: string;
  offline: boolean;
  fakeGcsUrl?: string;
  bucketName: string;
  fetchFn?: FetchLike;
};

export type FixtureRunContext = {
  client: FleetClient;
  rpcUrl: string;
  chainId: number;
  addresses: FleetAddresses;
  keys: FleetKeys;
  /** Present only in fast/test mode (a fresh Anvil this process fully controls):
   *  `evm_increaseTime` + `evm_mine`. When absent, every wait is a real wall-clock poll, matching
   *  "moves nothing by RPC in real runs" (task 8 controller notes). */
  advanceTime?: (seconds: number) => Promise<void>;
  /** `FLEET_MAX_FEE_PER_GAS_WEI`/`FLEET_MAX_GAS` as parsed by `parseSignerFeeLimits`, handed to
   *  every `FleetSigner` this fixture builds (spec 10.7, final review M1). Absent means
   *  unbounded. */
  feeLimits?: { maxFeePerGasWei?: bigint; maxGas?: bigint };
  /** How much of the voting window must remain for a worker to submit (mirrors
   *  `FLEET_SUBMISSION_MARGIN_SEC`); the `late-vote` fixture depends on this being small relative
   *  to the deploy config's `votingPeriod`. */
  submissionMarginSec: number;
  log?: (message: string) => void;
  /** Called once the trigger proposal's id is known (freshly submitted, or found already existing
   *  on resume), before anything else about the fixture is driven (task 8 finding 1). A caller
   *  that persists run state (`fleet run`) uses this to write a per-fixture sub-checkpoint, so a
   *  crash-and-resume has a record of which proposal this fixture was already on, independent of
   *  the top-level stage checkpoint (which only advances once the whole stage returns). */
  onProposalKnown?: (proposalId: bigint, txHash: Hex) => Promise<void> | void;
  /** When set, the read side is enabled: after propose, after every scripted vote, and after the
   *  fixture reaches its final state, `runFixture` inserts the new `fleet.votes` rows CPLS needs
   *  and posts+waits for a CPLS archive sync (task 8 finding 3). `undefined` (the default) means
   *  the read side is not part of this run, matching `fleet demo` without `--readside`. */
  readSideSync?: ReadSideSyncConfig;
};

export type FixtureVoteResult = {
  agentId: number;
  voterAddress: Address;
  directive: string;
  jobState: JobState;
  vote: VoteV1 | null;
  txHash: Hex | null;
  lastError: string | null;
};

export type GuardianActionResult = {
  operationId: Hex;
  pauseTxHash: Hex;
  cancelTxHash: Hex;
  unpauseTxHash: Hex;
};

export type ImpostorAttemptResult = {
  proposeReverted: boolean;
  proposeError: string;
  voteReverted: boolean;
  voteError: string;
};

export type FeeEntry = { txHash: Hex; gasUsed: string; effectiveGasPrice: string; feeWei: string };

export type FixtureRunResult = {
  fixture: FixtureV1;
  taskId: bigint;
  proposalId: bigint;
  proposeTxHash: Hex;
  description: string;
  decision: DecisionV1;
  trace: DecisionTrace;
  votes: FixtureVoteResult[];
  missingVotes: number;
  gatewayBefore: GatewayLogRecord | null;
  gatewayAfter: GatewayLogRecord | null;
  guardian: GuardianActionResult | null;
  impostor: ImpostorAttemptResult | null;
  finalState: ProposalState;
  finalStateName: string;
  decisionCount: number;
  charterVersionAfter: number;
  fees: FeeEntry[];
  pass: boolean;
  mismatches: string[];
  timings: { startedAt: string; activeAt: string; votingClosedAt: string; finishedAt: string };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deliberately not given an explicit return type: annotating it with a named interface would
 *  erase the concrete `Account`/`Chain` generics viem infers here, which is what lets every call
 *  site below use `writeContract`/`sendTransaction` without repeating `account`/`chain`. */
function buildWallet(ctx: FixtureRunContext, key: Hex) {
  const chain = defineChain({
    id: ctx.chainId,
    name: `fleet-runner-${ctx.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [ctx.rpcUrl] } },
  });
  return createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(ctx.rpcUrl) }).extend(
    publicActions,
  );
}

/** Reconstructed rather than passed through directly, so the result's `args` key is always
 *  present (matching `describeAction`'s required `args: unknown`) even though `FixtureAction`'s
 *  own `args` key is optional under this project's `exactOptionalPropertyTypes`. */
function toGatewayAction(action: { class: ActionClass; target: string; args?: unknown }): {
  class: ActionClass;
  target: string;
  args: unknown;
} {
  return { class: action.class, target: action.target, args: action.args };
}

function signerPolicy(ctx: FixtureRunContext): SignerPolicy {
  return {
    chainId: ctx.chainId,
    governor: ctx.addresses.governor,
    ledger: ctx.addresses.ledger,
    token: ctx.addresses.token,
    // Spec 10.7's "configured fee limits" (final review M1): unset means unbounded.
    ...(ctx.feeLimits?.maxFeePerGasWei !== undefined ? { maxFeePerGasWei: ctx.feeLimits.maxFeePerGasWei } : {}),
    ...(ctx.feeLimits?.maxGas !== undefined ? { maxGas: ctx.feeLimits.maxGas } : {}),
  };
}

function newSigner(ctx: FixtureRunContext, key: Hex): FleetSigner {
  const nonces = new NonceManager(new MemoryNonceStore(), ctx.rpcUrl);
  return new FleetSigner({ privateKey: key, rpcUrl: ctx.rpcUrl, policy: signerPolicy(ctx), nonces });
}

async function waitTick(ctx: FixtureRunContext, seconds: number): Promise<void> {
  if (ctx.advanceTime) {
    await ctx.advanceTime(seconds);
  } else {
    await sleep(Math.min(seconds, 5) * 1000);
  }
}

/** In fast/test mode (`ctx.advanceTime` set), jumps chain time directly to `target` in one RPC
 *  round trip instead of many small `waitTick` increments, so a long `votingDelay`/`votingPeriod`
 *  (the same config real infra uses) costs the same handful of RPC calls as a short one. A no-op
 *  when `target` is already in the past. */
async function jumpToTimestamp(ctx: FixtureRunContext, target: bigint): Promise<void> {
  if (!ctx.advanceTime) return;
  const now = await ctx.client.timestamp();
  if (target > now) {
    await ctx.advanceTime(Number(target - now) + 1);
  }
}

async function waitForActive(ctx: FixtureRunContext, proposalId: bigint): Promise<void> {
  const timing = await ctx.client.getProposalTiming(proposalId);
  await jumpToTimestamp(ctx, timing.snapshot);
  for (let i = 0; i < 400; i++) {
    const state = await ctx.client.getProposalState(proposalId);
    if (state === ProposalState.Active) return;
    if (state !== ProposalState.Pending) {
      throw new Error(`proposal ${proposalId.toString()} left Pending without becoming Active (state=${ProposalState[state]})`);
    }
    await waitTick(ctx, 3);
  }
  throw new Error(`proposal ${proposalId.toString()} did not become Active in time`);
}

async function waitForVotingClose(ctx: FixtureRunContext, proposalId: bigint): Promise<void> {
  const timing = await ctx.client.getProposalTiming(proposalId);
  await jumpToTimestamp(ctx, timing.deadline);
  for (let i = 0; i < 400; i++) {
    const state = await ctx.client.getProposalState(proposalId);
    if (state !== ProposalState.Active && state !== ProposalState.Pending) return;
    await waitTick(ctx, 5);
  }
  throw new Error(`proposal ${proposalId.toString()} did not leave Active in time`);
}

async function driveToQueued(ctx: FixtureRunContext, keeperWallet: WalletClient, proposalId: bigint): Promise<void> {
  const keeper = new Keeper({ client: ctx.client, wallet: keeperWallet, addresses: ctx.addresses });
  for (let i = 0; i < 200; i++) {
    const state = await ctx.client.getProposalState(proposalId);
    // `Executed` is past `Queued`, not a failure to reach it: a resumed fixture whose keeper work
    // already finished has nothing left to queue (final review I1, stage idempotency).
    if (state === ProposalState.Queued || state === ProposalState.Executed) return;
    if (state !== ProposalState.Succeeded) {
      throw new Error(`cannot queue proposal ${proposalId.toString()} from state ${ProposalState[state]}`);
    }
    // `Keeper` (constructed with no `confirmations`) returns as soon as the queue transaction is
    // sent, not once it is mined, so a "queued" result here does not yet mean `getProposalState`
    // will report `Queued`: loop back and re-read the real on-chain state rather than trusting
    // the return value directly.
    await keeper.reconcileProposal(proposalId);
    await waitTick(ctx, 2);
  }
  throw new Error(`proposal ${proposalId.toString()} was not queued in time`);
}

async function driveToExecuted(ctx: FixtureRunContext, keeperWallet: WalletClient, proposalId: bigint): Promise<void> {
  await driveToQueued(ctx, keeperWallet, proposalId);
  const keeper = new Keeper({ client: ctx.client, wallet: keeperWallet, addresses: ctx.addresses });
  const timing = await ctx.client.getProposalTiming(proposalId);
  for (let i = 0; i < 200; i++) {
    const now = await ctx.client.timestamp();
    if (now >= timing.eta) break;
    await waitTick(ctx, Number(timing.eta - now));
  }
  for (let i = 0; i < 200; i++) {
    const state = await ctx.client.getProposalState(proposalId);
    if (state === ProposalState.Executed) return;
    if (state !== ProposalState.Queued) {
      throw new Error(`cannot execute proposal ${proposalId.toString()} from state ${ProposalState[state]}`);
    }
    // Same reasoning as `driveToQueued`: `Keeper` returns once the execute transaction is sent,
    // not once it is mined, so re-check real state on the next iteration rather than trusting the
    // return value directly.
    await keeper.reconcileProposal(proposalId);
    await waitTick(ctx, 2);
  }
  throw new Error(`proposal ${proposalId.toString()} was not executed in time`);
}

async function roleForAgent(ctx: FixtureRunContext, agentId: number): Promise<string> {
  const members = await ctx.client.listMembers();
  const member = members.find((m) => m.agentId === agentId);
  if (!member) return "agent";
  try {
    const parsed: unknown = JSON.parse(member.manifest);
    if (parsed && typeof parsed === "object" && "role" in parsed && typeof (parsed as { role: unknown }).role === "string") {
      return (parsed as { role: string }).role;
    }
  } catch {
    // fall through
  }
  return "agent";
}

type TriggerDecision = { decision: DecisionV1; description: string; payloadHash: Hex; newCharterText: string };

/** Deterministically rebuilds the fixture's trigger decision and its proposal description,
 *  without sending anything. Shared by `submitTrigger` and `findExistingProposal` (task 8 finding
 *  1: resuming a fixture mid-`AGENTS_RUNNING` must recompute the exact same proposal id a fresh
 *  submission would have used, so both paths have to build byte-identical calldata/description). */
export async function buildTriggerDecision(ctx: FixtureRunContext, taskId: bigint, fixture: FixtureV1): Promise<TriggerDecision> {
  const task = await ctx.client.getTask(taskId);
  const expectedVersion = task.charterVersion;

  let payloadHash: Hex;
  let newCharterText = "";
  const trigger = fixture.trigger;
  if (trigger.action) {
    const descriptor = describeAction(toGatewayAction(trigger.action));
    payloadHash = payloadHashForAction(descriptor);
  } else if (trigger.newCharter) {
    newCharterText = canonicalize(trigger.newCharter);
    payloadHash = payloadHashForCharter(newCharterText);
  } else {
    throw new Error(`fixture ${fixture.name}: trigger has neither action nor newCharter`);
  }

  const decision: DecisionV1 = {
    schema: "fleet.decision.v1",
    taskId: taskId.toString(),
    kind: trigger.kind,
    expectedVersion,
    payloadHash,
    proposerAgentId: trigger.agentId,
    ...(trigger.action ? { action: describeAction(toGatewayAction(trigger.action)) } : {}),
    ...(trigger.newCharter ? { newCharter: trigger.newCharter } : {}),
    summary: trigger.summary,
    rationale: fixture.description,
    assumptions: [],
    riskFlags: [],
  };

  const roleLabel = await roleForAgent(ctx, trigger.agentId);
  const description = buildDecisionDescription(decision, roleLabel);

  return { decision, description, payloadHash, newCharterText };
}

/** Computes the proposal id a `propose()` call for `built` would resolve to, without sending
 *  anything: a pure hash (`AgoraGovernor.getProposalId`) of the same targets/values/calldata/
 *  descriptionHash `FleetSigner.propose` builds internally. */
export async function computeTriggerProposalId(ctx: FixtureRunContext, taskId: bigint, fixture: FixtureV1, built: TriggerDecision): Promise<bigint> {
  const calldata = encodeRecordDecision({
    taskId,
    kind: fixture.trigger.kind,
    expectedVersion: built.decision.expectedVersion,
    payloadHash: built.payloadHash,
    newCharterText: built.newCharterText,
    summary: fixture.trigger.summary,
  });
  const descriptionHash = keccak256(toHex(built.description));
  return ctx.client.publicClient.readContract({
    address: ctx.addresses.governor,
    abi: agoraGovernorAbi,
    functionName: "getProposalId",
    args: [[ctx.addresses.ledger], [0n], [calldata], descriptionHash],
  });
}

/**
 * Task 8 finding 1: `AGENTS_RUNNING` re-submitting the trigger proposal on every resume hits a
 * governor revert once the proposal already exists (a proposer may have only one unsettled
 * proposal per task). Before submitting, recompute the exact proposal id a submission would use
 * (deterministic; needs no chain write) and check whether `FleetHook`'s `DecisionProposed`/the
 * governor's own `ProposalCreated` log for it already exists. Returns `null` for a genuinely fresh
 * fixture (no such log yet); returns the existing proposal's identity for a resumed one, so
 * `runFixture` can skip straight to reading current chain state (votes via `hasVoted`, queue/
 * execute via governor `state()`) instead of re-submitting.
 */
export async function findExistingProposal(
  ctx: FixtureRunContext,
  taskId: bigint,
  fixture: FixtureV1,
): Promise<{ proposalId: bigint; txHash: Hex; description: string; decision: DecisionV1 } | null> {
  const built = await buildTriggerDecision(ctx, taskId, fixture);
  const proposalId = await computeTriggerProposalId(ctx, taskId, fixture, built);
  try {
    const created = await ctx.client.getProposalCreated(proposalId);
    return { proposalId, txHash: created.txHash, description: built.description, decision: built.decision };
  } catch {
    return null;
  }
}

/** Submits the fixture's `trigger` as a real proposal, from `trigger.agentId`'s key, through
 *  `FleetSigner.propose` (task 8 controller notes). Callers must first check
 *  `findExistingProposal` (task 8 finding 1); this function always sends a transaction. */
async function submitTrigger(
  ctx: FixtureRunContext,
  taskId: bigint,
  fixture: FixtureV1,
): Promise<{ proposalId: bigint; txHash: Hex; description: string; decision: DecisionV1 }> {
  const built = await buildTriggerDecision(ctx, taskId, fixture);
  const trigger = fixture.trigger;

  const key = ctx.keys.agentKeys[trigger.agentId];
  if (!key) throw new Error(`fixture ${fixture.name}: no key configured for proposer agent ${trigger.agentId}`);
  const signer = newSigner(ctx, key);
  const { txHash, proposalId } = await signer.propose({
    taskId,
    kind: trigger.kind,
    expectedVersion: built.decision.expectedVersion,
    payloadHash: built.payloadHash,
    newCharterText: built.newCharterText,
    summary: trigger.summary,
    description: built.description,
  });

  return { proposalId, txHash, description: built.description, decision: built.decision };
}

const LATE_SLACK_SEC = 3;

/** Casts every scripted vote in `fixture.script`, in ascending agent id order, using
 *  `@fleet/agent-runtime`'s real `Worker` + `ScriptedPolicy` per agent (task 8 controller notes:
 *  "in-process loops"). The `LATE` directive is made to actually miss the submission-margin check
 *  deterministically: in fast/test mode (`ctx.advanceTime` set) the chain clock is jumped to just
 *  inside the margin before that agent's worker ever looks; otherwise `ScriptedPolicy`'s own
 *  `lateDelayMs` makes the worker wait (in real wall-clock time) until the same point. */
async function castVotes(ctx: FixtureRunContext, proposalId: bigint, fixture: FixtureV1): Promise<FixtureVoteResult[]> {
  const results: FixtureVoteResult[] = [];
  const entries = Object.entries(fixture.script).sort(([a], [b]) => Number(a) - Number(b));

  for (const [agentIdStr, directive] of entries) {
    const agentId = Number(agentIdStr);
    const key = ctx.keys.agentKeys[agentId];
    if (!key) throw new Error(`fixture ${fixture.name}: no key configured for agent ${agentId}`);

    let lateDelayMs = 0;
    if (directive === "LATE") {
      const timing = await ctx.client.getProposalTiming(proposalId);
      const now = await ctx.client.timestamp();
      if (ctx.advanceTime) {
        const target = timing.deadline - BigInt(LATE_SLACK_SEC);
        if (target > now) await ctx.advanceTime(Number(target - now));
      } else {
        const remainingSec = Number(timing.deadline - now);
        lateDelayMs = Math.max(0, remainingSec - ctx.submissionMarginSec + LATE_SLACK_SEC) * 1000;
      }
    }

    const signer = newSigner(ctx, key);
    const policy = new ScriptedPolicy({ [agentId]: directive }, { lateDelayMs });
    const worker = new Worker({
      agentId,
      signer,
      client: ctx.client,
      policy,
      jobs: new MemoryJobStore(),
      nonces: new NonceManager(new MemoryNonceStore(), ctx.rpcUrl),
      submissionMarginSec: ctx.submissionMarginSec,
      pollMs: 1000,
    });
    const job = await worker.handleProposal(proposalId);
    results.push({
      agentId,
      voterAddress: signer.address,
      directive,
      jobState: job.state,
      vote: job.vote,
      txHash: job.txHash,
      lastError: job.lastError,
    });
  }

  return results;
}

/** Attempts `propose` then `castVoteWithReason` (on the fixture's real, already-Active proposal)
 *  from a freshly generated, unregistered key through a raw viem wallet client (never
 *  `FleetSigner`), recording each `HookCallFailed` revert (task 8 controller notes: impostor
 *  fixture). Funds the impostor account first so gas estimation never fails purely on balance. */
async function impostorAttempt(
  ctx: FixtureRunContext,
  taskId: bigint,
  proposalId: bigint,
  expectedVersion: number,
): Promise<ImpostorAttemptResult> {
  const impostorKey = generatePrivateKey();
  const impostorAccount = privateKeyToAccount(impostorKey);

  const funder = buildWallet(ctx, ctx.keys.operatorKey);
  const fundHash = await funder.sendTransaction({ to: impostorAccount.address, value: parseEther("1") });
  await ctx.client.publicClient.waitForTransactionReceipt({ hash: fundHash });

  const impostorWallet = buildWallet(ctx, impostorKey);

  const action = { class: "read_repo" as ActionClass, target: "impostor-attempt", argsHash: `0x${"11".repeat(32)}` as Hex };
  const payloadHash = payloadHashForAction(action);
  const summary = "Impostor attempt (expected to revert; never a legitimate proposal)";
  const decision: DecisionV1 = {
    schema: "fleet.decision.v1",
    taskId: taskId.toString(),
    kind: "GRANT_EXCEPTION",
    expectedVersion,
    payloadHash,
    proposerAgentId: 999,
    action,
    summary,
    rationale: "An unregistered signer attempts to propose; the hook must reject it.",
    assumptions: [],
    riskFlags: [],
  };
  const description = buildDecisionDescription(decision, "impostor");
  const calldata = encodeRecordDecision({ taskId, kind: "GRANT_EXCEPTION", expectedVersion, payloadHash, newCharterText: "", summary });

  let proposeError = "";
  let proposeReverted = true;
  try {
    await impostorWallet.writeContract({
      address: ctx.addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "propose",
      args: [[ctx.addresses.ledger], [0n], [calldata], description],
    });
    proposeReverted = false;
    proposeError = "SECURITY ISSUE: impostor propose() did not revert";
  } catch (err) {
    proposeError = explainRevert(err);
  }

  let voteError = "";
  let voteReverted = true;
  try {
    await impostorWallet.writeContract({
      address: ctx.addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "castVoteWithReason",
      args: [proposalId, 1, "FOR. impostor attempt"],
    });
    voteReverted = false;
    voteError = "SECURITY ISSUE: impostor castVoteWithReason() did not revert";
  } catch (err) {
    voteError = explainRevert(err);
  }

  return { proposeReverted, proposeError, voteReverted, voteError };
}

/** Delegates `step.agentId`'s voting power to `step.toAgentId` through `FleetSigner.delegate`
 *  (task 8 controller notes: delegation fixture pre-step), before the trigger proposal is
 *  submitted (voting power is snapshotted at proposal creation). Returns the transaction hash. */
async function applyDelegateStep(
  ctx: FixtureRunContext,
  step: { agentId: number; toAgentId: number },
): Promise<Hex> {
  const key = ctx.keys.agentKeys[step.agentId];
  const toKey = ctx.keys.agentKeys[step.toAgentId];
  if (!key || !toKey) throw new Error(`delegate preStep: missing key for agent ${step.agentId} or ${step.toAgentId}`);
  const toAddress = privateKeyToAccount(toKey).address;
  const signer = newSigner(ctx, key);
  const { txHash } = await signer.delegate(toAddress);
  await ctx.client.publicClient.waitForTransactionReceipt({ hash: txHash });
  return txHash;
}

/** Pauses the ledger, cancels the queued timelock operation with the guardian key (`timelock.cancel`,
 *  salt `bytes20(governor) ^ keccak256(description)`), asserts the governor now reports `Canceled`,
 *  then unpauses (task 8 controller notes: guardian fixture). */
async function guardianPauseAndCancel(
  ctx: FixtureRunContext,
  proposalId: bigint,
  description: string,
): Promise<GuardianActionResult> {
  const guardianWallet = buildWallet(ctx, ctx.keys.guardianKey);

  const pauseTxHash = await guardianWallet.writeContract({ address: ctx.addresses.ledger, abi: taskLedgerAbi, functionName: "pause" });
  await ctx.client.publicClient.waitForTransactionReceipt({ hash: pauseTxHash });

  const created = await ctx.client.getProposalCreated(proposalId);
  const descriptionHash = keccak256(toHex(description));
  const salt = timelockSalt(ctx.addresses.governor, descriptionHash);
  const operationId = await ctx.client.publicClient.readContract({
    address: ctx.addresses.timelock,
    abi: timelockControllerAbi,
    functionName: "hashOperationBatch",
    args: [created.targets as Address[], created.values as bigint[], created.calldatas as Hex[], ZERO_BYTES32, salt],
  });

  const cancelTxHash = await guardianWallet.writeContract({
    address: ctx.addresses.timelock,
    abi: timelockControllerAbi,
    functionName: "cancel",
    args: [operationId],
  });
  await ctx.client.publicClient.waitForTransactionReceipt({ hash: cancelTxHash });

  const state = await ctx.client.getProposalState(proposalId);
  if (state !== ProposalState.Canceled) {
    throw new Error(`expected Canceled after guardian cancel, got ${ProposalState[state]}`);
  }

  const unpauseTxHash = await guardianWallet.writeContract({ address: ctx.addresses.ledger, abi: taskLedgerAbi, functionName: "unpause" });
  await ctx.client.publicClient.waitForTransactionReceipt({ hash: unpauseTxHash });

  return { operationId, pauseTxHash, cancelTxHash, unpauseTxHash };
}

function deriveAmendmentCheckAction(newCharter: CharterV1): { class: ActionClass; target: string; args: unknown } {
  const host = newCharter.externalAllowlist.at(-1);
  if (!host) throw new Error("cannot derive a gateway check action: newCharter has an empty externalAllowlist");
  return { class: "network_fetch", target: host, args: {} };
}

async function computeFees(ctx: FixtureRunContext, txHashes: readonly Hex[]): Promise<FeeEntry[]> {
  const unique = [...new Set(txHashes.map((h) => h.toLowerCase()))] as Hex[];
  const fees: FeeEntry[] = [];
  for (const hash of unique) {
    const receipt = await ctx.client.publicClient.getTransactionReceipt({ hash });
    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
    fees.push({
      txHash: hash,
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      feeWei: (gasUsed * effectiveGasPrice).toString(),
    });
  }
  return fees;
}

/** After a governance transaction, syncs the read side when it is enabled (task 8 finding 3):
 *  waits for DAO Node to index whatever `daoNodePredicate` describes, then posts a CPLS sync job
 *  and waits for its archive object. A no-op when `ctx.readSideSync` is not set. */
async function syncReadSideStage(
  ctx: FixtureRunContext,
  proposalId: bigint,
  label: string,
  daoNode: { url: string; predicate: (body: unknown) => boolean; description: string },
): Promise<void> {
  const sync = ctx.readSideSync;
  if (!sync) return;
  const log = ctx.log ?? (() => {});
  const fetchFn = sync.fetchFn ?? ((url, init) => fetch(url, init as never) as unknown as ReturnType<FetchLike>);
  await waitForDaoNode(fetchFn, daoNode.url, daoNode.predicate, { description: daoNode.description });
  await syncCplsAfterStage(fetchFn, {
    cplsUrl: sync.cplsUrl,
    identity: { governor: ctx.addresses.governor, chainId: ctx.chainId },
    archive: { offline: sync.offline, bucketName: sync.bucketName, ...(sync.fakeGcsUrl ? { fakeGcsUrl: sync.fakeGcsUrl } : {}) },
    proposalId: proposalId.toString(),
    label,
    log,
  });
}

/** Inserts one `fleet.votes` row per `VoteCast` event this proposal has emitted so far (task 8
 *  finding 3), reading each vote's real transaction hash, block number, and weight back off the
 *  chain rather than assuming them, matching `infra/scripts/scripted-proposal.sh`'s own
 *  `insert_vote_row`. Safe to call more than once for the same proposal (the resumed-fixture case,
 *  finding 1): the table's own unique index makes a repeat insert a no-op. */
async function insertVoteRowsFromChain(ctx: FixtureRunContext, proposalId: bigint): Promise<number> {
  const sync = ctx.readSideSync;
  if (!sync) return 0;
  const trace = await getDecisionTrace(ctx.client, proposalId);
  const voteCasts = trace.events.filter((e): e is Extract<typeof e, { type: "VoteCast" }> => e.type === "VoteCast");
  for (const vc of voteCasts) {
    await insertVoteRow(sync.votesPool, {
      proposalId: proposalId.toString(),
      transactionHash: vc.txHash,
      blockNumber: vc.blockNumber,
      chainId: ctx.chainId,
      voter: vc.voter,
      support: vc.support,
      weight: vc.weight,
      reason: vc.reason,
      contract: ctx.addresses.governor,
    });
  }
  return voteCasts.length;
}

/**
 * Runs one scripted fixture end to end on `taskId` (task 8 brief and controller notes): applies
 * `preSteps`, submits the trigger proposal, casts every scripted vote, drives the proposal to the
 * fixture's `expected.outcome` (queueing and executing only when the outcome calls for it, and
 * applying the guardian's pause-and-cancel when either `expected.outcome` is `"Canceled"` or
 * `fixture.guardian.pauseAndCancelAfterQueue` is set), and asserts every field of `expected`.
 */
export async function runFixture(ctx: FixtureRunContext, fixture: FixtureV1, taskId: bigint): Promise<FixtureRunResult> {
  const startedAt = new Date().toISOString();
  const log = ctx.log ?? (() => {});
  log(`fixture ${fixture.name}: starting on task ${taskId.toString()}`);

  let gatewayBefore: GatewayLogRecord | null = null;
  if (fixture.trigger.action) {
    gatewayBefore = (await checkGateway(ctx.client, taskId, fixture.trigger.agentId, fixture.trigger.action)).record;
  }

  const extraTxHashes: Hex[] = [];

  for (const step of fixture.preSteps ?? []) {
    if (step.kind === "delegate") {
      extraTxHashes.push(await applyDelegateStep(ctx, step));
    }
  }

  let proposalId: bigint;
  let proposeTxHash: Hex;
  let description: string;
  let decision: DecisionV1;
  const existing = await findExistingProposal(ctx, taskId, fixture);
  if (existing) {
    ({ proposalId, txHash: proposeTxHash, description, decision } = existing);
    log(`fixture ${fixture.name}: found existing proposal ${proposalId.toString()} (resuming without re-submitting)`);
  } else {
    ({ proposalId, txHash: proposeTxHash, description, decision } = await submitTrigger(ctx, taskId, fixture));
    log(`fixture ${fixture.name}: proposal ${proposalId.toString()} submitted (${proposeTxHash})`);
    await ctx.client.publicClient.waitForTransactionReceipt({ hash: proposeTxHash });
  }
  if (ctx.onProposalKnown) await ctx.onProposalKnown(proposalId, proposeTxHash);

  // A resumed fixture whose proposal has already left the voting window has nothing to wait for
  // and nothing to drive: the crash happened after the governance cycle finished, and the whole
  // stage's job now is to re-read chain state and assert against it (final review I1, spec 12.2's
  // "each stage is idempotent and resumable by run ID"). `castVotes` below stays unconditional:
  // every worker re-checks `hasVoted` and the submission window itself, so a vote already cast
  // reads back as `already_voted` without sending anything.
  const stateOnEntry = await ctx.client.getProposalState(proposalId);
  const votingOver =
    existing !== null && stateOnEntry !== ProposalState.Pending && stateOnEntry !== ProposalState.Active;
  if (votingOver) {
    log(`fixture ${fixture.name}: proposal ${proposalId.toString()} is already ${ProposalState[stateOnEntry]}; re-reading rather than re-driving`);
  }

  if (ctx.readSideSync) {
    await syncReadSideStage(ctx, proposalId, "proposed", {
      url: `${ctx.readSideSync.daoNodeUrl}/v1/proposal/${proposalId.toString()}`,
      predicate: (body) => (body as { proposal?: { id?: string } })?.proposal?.id === proposalId.toString(),
      description: `DAO Node to index proposal ${proposalId.toString()}`,
    });
  }

  if (!votingOver) await waitForActive(ctx, proposalId);
  const activeAt = new Date().toISOString();

  let impostor: ImpostorAttemptResult | null = null;
  if ((fixture.preSteps ?? []).some((s) => s.kind === "impostorAttempt")) {
    const task = await ctx.client.getTask(taskId);
    impostor = await impostorAttempt(ctx, taskId, proposalId, task.charterVersion);
    log(`fixture ${fixture.name}: impostor attempt propose=${impostor.proposeReverted ? "reverted" : "SUCCEEDED"} vote=${impostor.voteReverted ? "reverted" : "SUCCEEDED"}`);
  }

  const votes = await castVotes(ctx, proposalId, fixture);
  const missingVotes = votes.filter((v) => v.jobState === "missed" || v.jobState === "absent").length;

  if (ctx.readSideSync) {
    const insertedCount = await insertVoteRowsFromChain(ctx, proposalId);
    const castCount = votes.filter((v) => v.jobState === "voted").length;
    await syncReadSideStage(ctx, proposalId, "voted", {
      url: `${ctx.readSideSync.daoNodeUrl}/v1/vote_record/${proposalId.toString()}`,
      predicate: (body) => Array.isArray((body as { vote_record?: unknown[] })?.vote_record) && ((body as { vote_record: unknown[] }).vote_record.length >= castCount),
      description: `DAO Node to index ${castCount} votes for proposal ${proposalId.toString()}`,
    });
    ctx.log?.(`fixture ${fixture.name}: inserted ${insertedCount} fleet.votes row(s) for proposal ${proposalId.toString()}`);
  }

  await waitForVotingClose(ctx, proposalId);
  const votingClosedAt = new Date().toISOString();

  let guardian: GuardianActionResult | null = null;
  const wantsCancel = fixture.expected.outcome === "Canceled" || fixture.guardian?.pauseAndCancelAfterQueue === true;
  const alreadyCanceled = (await ctx.client.getProposalState(proposalId)) === ProposalState.Canceled;
  if (fixture.expected.outcome === "Executed") {
    const keeperWallet = buildWallet(ctx, ctx.keys.keeperKey);
    await driveToExecuted(ctx, keeperWallet, proposalId);
  } else if (wantsCancel && alreadyCanceled) {
    // A resumed guardian fixture: the pause, cancel and unpause already happened, and re-running
    // them would cancel an operation that no longer exists. `guardian` stays null; the assertions
    // below read the outcome off chain, which is what they check.
    log(`fixture ${fixture.name}: proposal ${proposalId.toString()} was already canceled; skipping the guardian pre-step`);
  } else if (wantsCancel) {
    const keeperWallet = buildWallet(ctx, ctx.keys.keeperKey);
    await driveToQueued(ctx, keeperWallet, proposalId);
    guardian = await guardianPauseAndCancel(ctx, proposalId, description);
    extraTxHashes.push(guardian.pauseTxHash, guardian.cancelTxHash, guardian.unpauseTxHash);
  }
  // Succeeded / Defeated: nothing further to drive.

  const finalState = await ctx.client.getProposalState(proposalId);
  const finalStateName = ProposalState[finalState] as FixtureRunResult["finalStateName"];
  const task = await ctx.client.getTask(taskId);

  if (ctx.readSideSync) {
    const daoNodeUrl = `${ctx.readSideSync.daoNodeUrl}/v1/proposal/${proposalId.toString()}`;
    const predicate =
      finalState === ProposalState.Executed
        ? (body: unknown): boolean => (body as { proposal?: { execute_event?: unknown } })?.proposal?.execute_event != null
        : (body: unknown): boolean => (body as { proposal?: { id?: string } })?.proposal?.id === proposalId.toString();
    await syncReadSideStage(ctx, proposalId, finalStateName.toLowerCase(), {
      url: daoNodeUrl,
      predicate,
      description: `DAO Node to reflect final state ${finalStateName} for proposal ${proposalId.toString()}`,
    });
  }

  let gatewayAfter: GatewayLogRecord | null = null;
  if (fixture.expected.gatewayAfter) {
    const checkAction = fixture.trigger.action ?? deriveAmendmentCheckAction(fixture.trigger.newCharter as CharterV1);
    gatewayAfter = (await checkGateway(ctx.client, taskId, fixture.trigger.agentId, checkAction)).record;
  }

  const trace = await getDecisionTrace(ctx.client, proposalId);

  // Delegation moves voting power on `FleetVotes` itself, not on this fixture's task: left in
  // place, it would silently change every later fixture's vote tallies in the same demo run
  // (voting power is shared across the whole deployment, tasks are not). Once every assertion
  // above has already read the state it needed, delegating each delegator back to themselves
  // restores the one-member-one-vote baseline for whatever fixture runs next.
  for (const step of fixture.preSteps ?? []) {
    if (step.kind === "delegate") {
      await applyDelegateStep(ctx, { agentId: step.agentId, toAgentId: step.agentId });
    }
  }

  const finishedAt = new Date().toISOString();

  const traceTxHashes = trace.events.map((e) => e.txHash);
  const fees = await computeFees(ctx, [...traceTxHashes, ...extraTxHashes]);

  const mismatches: string[] = [];
  if (finalStateName !== fixture.expected.outcome) {
    mismatches.push(`outcome: expected ${fixture.expected.outcome}, got ${finalStateName}`);
  }
  if (task.decisionCount !== fixture.expected.decisionCount) {
    mismatches.push(`decisionCount: expected ${fixture.expected.decisionCount}, got ${task.decisionCount}`);
  }
  if (fixture.expected.charterVersion !== undefined && task.charterVersion !== fixture.expected.charterVersion) {
    mismatches.push(`charterVersion: expected ${fixture.expected.charterVersion}, got ${task.charterVersion}`);
  }
  if (fixture.expected.gatewayAfter !== undefined && gatewayAfter && gatewayAfter.verdict !== fixture.expected.gatewayAfter) {
    mismatches.push(`gatewayAfter: expected ${fixture.expected.gatewayAfter}, got ${gatewayAfter.verdict}`);
  }
  if (fixture.expected.missingVotes !== undefined && missingVotes !== fixture.expected.missingVotes) {
    mismatches.push(`missingVotes: expected ${fixture.expected.missingVotes}, got ${missingVotes}`);
  }
  if (fixture.expected.revertedAttempts !== undefined) {
    const actual = impostor ? Number(impostor.proposeReverted) + Number(impostor.voteReverted) : 0;
    if (actual !== fixture.expected.revertedAttempts) {
      mismatches.push(`revertedAttempts: expected ${fixture.expected.revertedAttempts}, got ${actual}`);
    }
  }

  log(`fixture ${fixture.name}: finished at ${finalStateName} (${mismatches.length === 0 ? "PASS" : "FAIL"})`);

  return {
    fixture,
    taskId,
    proposalId,
    proposeTxHash,
    description,
    decision,
    trace,
    votes,
    missingVotes,
    gatewayBefore,
    gatewayAfter,
    guardian,
    impostor,
    finalState,
    finalStateName,
    decisionCount: task.decisionCount,
    charterVersionAfter: task.charterVersion,
    fees,
    pass: mismatches.length === 0,
    mismatches,
    timings: { startedAt, activeAt, votingClosedAt, finishedAt },
  };
}
