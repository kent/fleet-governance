import type { Address, Hex } from "viem";
import { agoraGovernorAbi, fleetHookAbi, taskLedgerAbi } from "@fleet/abi";
import type { DecisionKind } from "@fleet/schemas";
import { decisionKindFromUint8 } from "./actions.js";
import type { FleetClient } from "./client.js";

export type DecisionTraceEvent =
  | {
      type: "TaskOpened";
      taskId: bigint;
      operator: Address;
      expiresAt: bigint;
      charterHash: Hex;
      charterText: string;
      blockNumber: bigint;
      logIndex: number;
      txHash: Hex;
    }
  | {
      type: "ProposalCreated";
      proposalId: bigint;
      proposer: Address;
      targets: readonly Address[];
      values: readonly bigint[];
      calldatas: readonly Hex[];
      description: string;
      blockNumber: bigint;
      logIndex: number;
      txHash: Hex;
    }
  | {
      type: "DecisionProposed";
      proposalId: bigint;
      taskId: bigint;
      kind: DecisionKind;
      expectedVersion: number;
      payloadHash: Hex;
      actionId: Hex;
      proposer: Address;
      blockNumber: bigint;
      logIndex: number;
      txHash: Hex;
    }
  | {
      type: "VoteCast";
      voter: Address;
      proposalId: bigint;
      support: 0 | 1 | 2;
      weight: bigint;
      reason: string;
      blockNumber: bigint;
      logIndex: number;
      txHash: Hex;
    }
  | { type: "ProposalQueued"; proposalId: bigint; etaSeconds: bigint; blockNumber: bigint; logIndex: number; txHash: Hex }
  | { type: "ProposalCanceled"; proposalId: bigint; blockNumber: bigint; logIndex: number; txHash: Hex }
  | { type: "ProposalExecuted"; proposalId: bigint; blockNumber: bigint; logIndex: number; txHash: Hex }
  | {
      type: "DecisionRecorded";
      taskId: bigint;
      index: number;
      kind: DecisionKind;
      charterVersionBefore: number;
      charterVersionAfter: number;
      payloadHash: Hex;
      actionId: Hex;
      summary: string;
      blockNumber: bigint;
      logIndex: number;
      txHash: Hex;
    };

export type DecisionTrace = {
  proposalId: bigint;
  actionId: Hex;
  taskId: bigint;
  /** Every event this proposal's lifecycle produced, ordered by block then log index. Optional
   *  events (`TaskOpened`, `ProposalQueued`, `ProposalCanceled`, `DecisionRecorded`) appear only
   *  when found; `VoteCast` appears zero or more times. */
  events: DecisionTraceEvent[];
};

function byBlockThenLogIndex(a: DecisionTraceEvent, b: DecisionTraceEvent): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/**
 * Assembles the full decision trace for one proposal by joining `FleetHook.DecisionProposed` and
 * `TaskLedger.DecisionRecorded` on `actionId`, never on the proposal id embedded in calldata
 * (spec 8: "Decode calldata; do not trust the title"; docs/compatibility-notes.md on `actionId`
 * existing precisely so these two events join without the proposal ID appearing in its own
 * calldata). Reads `DecisionProposed` by its indexed `proposalId` topic, then everything else that
 * shares this proposal's `taskId` or `proposalId`, and finally narrows `DecisionRecorded` (indexed
 * by `taskId`, not `actionId`) down to the one decision (if any) whose `actionId` matches.
 */
export async function getDecisionTrace(client: FleetClient, proposalId: bigint): Promise<DecisionTrace> {
  const proposedLogs = await client.publicClient.getContractEvents({
    address: client.addresses.hook,
    abi: fleetHookAbi,
    eventName: "DecisionProposed",
    args: { proposalId },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const proposedLog = proposedLogs[0];
  if (!proposedLog || proposedLog.args.actionId === undefined || proposedLog.args.taskId === undefined) {
    throw new Error(`no FleetHook.DecisionProposed log found for proposalId ${proposalId.toString()}`);
  }
  const actionId = proposedLog.args.actionId;
  const taskId = proposedLog.args.taskId;

  const events: DecisionTraceEvent[] = [];

  events.push({
    type: "DecisionProposed",
    proposalId,
    taskId,
    kind: decisionKindFromUint8(proposedLog.args.kind ?? 0),
    expectedVersion: proposedLog.args.expectedVersion ?? 0,
    payloadHash: proposedLog.args.payloadHash ?? ("0x" as Hex),
    actionId,
    proposer: (proposedLog.args.proposer ?? "0x0000000000000000000000000000000000000000") as Address,
    blockNumber: proposedLog.blockNumber,
    logIndex: proposedLog.logIndex,
    txHash: proposedLog.transactionHash,
  });

  const [created, votes, taskOpenedLogs, queuedLogs, canceledLogs, executedLogs, decisionLogs] = await Promise.all([
    client.getProposalCreated(proposalId),
    client.listVotes(proposalId),
    client.publicClient.getContractEvents({
      address: client.addresses.ledger,
      abi: taskLedgerAbi,
      eventName: "TaskOpened",
      args: { taskId },
      fromBlock: 0n,
      toBlock: "latest",
    }),
    client.publicClient.getContractEvents({
      address: client.addresses.governor,
      abi: agoraGovernorAbi,
      eventName: "ProposalQueued",
      fromBlock: 0n,
      toBlock: "latest",
    }),
    client.publicClient.getContractEvents({
      address: client.addresses.governor,
      abi: agoraGovernorAbi,
      eventName: "ProposalCanceled",
      fromBlock: 0n,
      toBlock: "latest",
    }),
    client.publicClient.getContractEvents({
      address: client.addresses.governor,
      abi: agoraGovernorAbi,
      eventName: "ProposalExecuted",
      fromBlock: 0n,
      toBlock: "latest",
    }),
    client.publicClient.getContractEvents({
      address: client.addresses.ledger,
      abi: taskLedgerAbi,
      eventName: "DecisionRecorded",
      args: { taskId },
      fromBlock: 0n,
      toBlock: "latest",
    }),
  ]);

  events.push({
    type: "ProposalCreated",
    proposalId: created.proposalId,
    proposer: created.proposer,
    targets: created.targets,
    values: created.values,
    calldatas: created.calldatas,
    description: created.description,
    blockNumber: created.blockNumber,
    logIndex: created.logIndex,
    txHash: created.txHash,
  });

  const taskOpenedLog = taskOpenedLogs[0];
  if (taskOpenedLog) {
    events.push({
      type: "TaskOpened",
      taskId,
      operator: (taskOpenedLog.args.operator ?? "0x0000000000000000000000000000000000000000") as Address,
      expiresAt: taskOpenedLog.args.expiresAt ?? 0n,
      charterHash: taskOpenedLog.args.charterHash ?? ("0x" as Hex),
      charterText: taskOpenedLog.args.charterText ?? "",
      blockNumber: taskOpenedLog.blockNumber,
      logIndex: taskOpenedLog.logIndex,
      txHash: taskOpenedLog.transactionHash,
    });
  }

  for (const vote of votes) {
    events.push({
      type: "VoteCast",
      voter: vote.voter,
      proposalId: vote.proposalId,
      support: vote.support,
      weight: vote.weight,
      reason: vote.reason,
      blockNumber: vote.blockNumber,
      logIndex: vote.logIndex,
      txHash: vote.txHash,
    });
  }

  const queuedLog = queuedLogs.find((l) => l.args.proposalId === proposalId);
  if (queuedLog) {
    events.push({
      type: "ProposalQueued",
      proposalId,
      etaSeconds: queuedLog.args.etaSeconds ?? 0n,
      blockNumber: queuedLog.blockNumber,
      logIndex: queuedLog.logIndex,
      txHash: queuedLog.transactionHash,
    });
  }

  const canceledLog = canceledLogs.find((l) => l.args.proposalId === proposalId);
  if (canceledLog) {
    events.push({
      type: "ProposalCanceled",
      proposalId,
      blockNumber: canceledLog.blockNumber,
      logIndex: canceledLog.logIndex,
      txHash: canceledLog.transactionHash,
    });
  }

  const executedLog = executedLogs.find((l) => l.args.proposalId === proposalId);
  if (executedLog) {
    events.push({
      type: "ProposalExecuted",
      proposalId,
      blockNumber: executedLog.blockNumber,
      logIndex: executedLog.logIndex,
      txHash: executedLog.transactionHash,
    });
  }

  const decisionLog = decisionLogs.find((l) => l.args.actionId === actionId);
  if (decisionLog && decisionLog.args.index !== undefined) {
    events.push({
      type: "DecisionRecorded",
      taskId,
      index: decisionLog.args.index,
      kind: decisionKindFromUint8(decisionLog.args.kind ?? 0),
      charterVersionBefore: decisionLog.args.charterVersionBefore ?? 0,
      charterVersionAfter: decisionLog.args.charterVersionAfter ?? 0,
      payloadHash: decisionLog.args.payloadHash ?? ("0x" as Hex),
      actionId,
      summary: decisionLog.args.summary ?? "",
      blockNumber: decisionLog.blockNumber,
      logIndex: decisionLog.logIndex,
      txHash: decisionLog.transactionHash,
    });
  }

  events.sort(byBlockThenLogIndex);

  return { proposalId, actionId, taskId, events };
}
