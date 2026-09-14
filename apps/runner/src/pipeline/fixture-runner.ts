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
import { ZERO_BYTES32, timelockSalt } from "./timelock.js";

export type FleetKeys = {
  deployerKey: Hex;
  operatorKey: Hex;
  guardianKey: Hex;
  keeperKey: Hex;
  agentKeys: Record<number, Hex>;
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
  /** How much of the voting window must remain for a worker to submit (mirrors
   *  `FLEET_SUBMISSION_MARGIN_SEC`); the `late-vote` fixture depends on this being small relative
   *  to the deploy config's `votingPeriod`. */
  submissionMarginSec: number;
  log?: (message: string) => void;
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
  return { chainId: ctx.chainId, governor: ctx.addresses.governor, ledger: ctx.addresses.ledger, token: ctx.addresses.token };
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
    if (state === ProposalState.Queued) return;
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

/** Submits the fixture's `trigger` as a real proposal, from `trigger.agentId`'s key, through
 *  `FleetSigner.propose` (task 8 controller notes). */
async function submitTrigger(
  ctx: FixtureRunContext,
  taskId: bigint,
  fixture: FixtureV1,
): Promise<{ proposalId: bigint; txHash: Hex; description: string; decision: DecisionV1 }> {
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

  const key = ctx.keys.agentKeys[trigger.agentId];
  if (!key) throw new Error(`fixture ${fixture.name}: no key configured for proposer agent ${trigger.agentId}`);
  const signer = newSigner(ctx, key);
  const { txHash, proposalId } = await signer.propose({
    taskId,
    kind: trigger.kind,
    expectedVersion,
    payloadHash,
    newCharterText,
    summary: trigger.summary,
    description,
  });

  return { proposalId, txHash, description, decision };
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

  const { proposalId, txHash: proposeTxHash, description, decision } = await submitTrigger(ctx, taskId, fixture);
  log(`fixture ${fixture.name}: proposal ${proposalId.toString()} submitted (${proposeTxHash})`);
  await ctx.client.publicClient.waitForTransactionReceipt({ hash: proposeTxHash });

  await waitForActive(ctx, proposalId);
  const activeAt = new Date().toISOString();

  let impostor: ImpostorAttemptResult | null = null;
  if ((fixture.preSteps ?? []).some((s) => s.kind === "impostorAttempt")) {
    const task = await ctx.client.getTask(taskId);
    impostor = await impostorAttempt(ctx, taskId, proposalId, task.charterVersion);
    log(`fixture ${fixture.name}: impostor attempt propose=${impostor.proposeReverted ? "reverted" : "SUCCEEDED"} vote=${impostor.voteReverted ? "reverted" : "SUCCEEDED"}`);
  }

  const votes = await castVotes(ctx, proposalId, fixture);
  const missingVotes = votes.filter((v) => v.jobState === "missed" || v.jobState === "absent").length;

  await waitForVotingClose(ctx, proposalId);
  const votingClosedAt = new Date().toISOString();

  let guardian: GuardianActionResult | null = null;
  const wantsCancel = fixture.expected.outcome === "Canceled" || fixture.guardian?.pauseAndCancelAfterQueue === true;
  if (fixture.expected.outcome === "Executed") {
    const keeperWallet = buildWallet(ctx, ctx.keys.keeperKey);
    await driveToExecuted(ctx, keeperWallet, proposalId);
  } else if (wantsCancel) {
    const keeperWallet = buildWallet(ctx, ctx.keys.keeperKey);
    await driveToQueued(ctx, keeperWallet, proposalId);
    guardian = await guardianPauseAndCancel(ctx, proposalId, description);
    extraTxHashes.push(guardian.pauseTxHash, guardian.cancelTxHash, guardian.unpauseTxHash);
  }
  // Succeeded / Defeated: nothing further to drive.

  const finalState = await ctx.client.getProposalState(proposalId);
  const task = await ctx.client.getTask(taskId);

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

  const finalStateName = ProposalState[finalState] as FixtureRunResult["finalStateName"];
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
