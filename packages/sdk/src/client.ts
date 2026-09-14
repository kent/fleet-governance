import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  defineChain,
  http,
  toFunctionSelector,
} from "viem";
import type { Address, Hex, PublicClient } from "viem";
import { agoraGovernorAbi, fleetRegistryAbi, fleetVotesAbi, taskLedgerAbi } from "@fleet/abi";
import { CharterV1, assertAllowedChain } from "@fleet/schemas";
import type { FleetAddresses } from "./addresses.js";
import { decisionKindFromUint8 } from "./actions.js";
import type { DecisionKind } from "@fleet/schemas";
import { parseVoteReason } from "./reason.js";
import type { ParsedVoteReason } from "./reason.js";

/** Mirrors `TaskLedger.TaskState` (contracts/src/TaskLedger.sol) in onchain enum order. */
export enum TaskState {
  Open = 0,
  Stopped = 1,
  Completed = 2,
  Expired = 3,
}

/** Mirrors OpenZeppelin's `IGovernor.ProposalState`, 0 to 7. */
export enum ProposalState {
  Pending = 0,
  Active = 1,
  Canceled = 2,
  Defeated = 3,
  Succeeded = 4,
  Queued = 5,
  Expired = 6,
  Executed = 7,
}

export type TaskView = {
  id: bigint;
  operator: Address;
  createdAt: bigint;
  expiresAt: bigint;
  state: TaskState;
  charterVersion: number;
  charterHash: Hex;
  decisionCount: number;
  openEscalations: number;
  charterText: string;
  charter: CharterV1 | null;
};

export type ProposalCreatedView = {
  proposalId: bigint;
  proposer: Address;
  targets: readonly Address[];
  values: readonly bigint[];
  calldatas: readonly Hex[];
  description: string;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
};

export type VoteCastView = {
  voter: Address;
  proposalId: bigint;
  support: 0 | 1 | 2;
  weight: bigint;
  reason: string;
  parsedReason: ParsedVoteReason;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
};

export type DecisionView = {
  taskId: bigint;
  index: number;
  kind: DecisionKind;
  charterVersionBefore: number;
  charterVersionAfter: number;
  payloadHash: Hex;
  actionId: Hex;
  summary: string;
  recordedAt: bigint;
  blockNumber: bigint;
  txHash: Hex;
};

function tryParseCharter(charterText: string): CharterV1 | null {
  try {
    const json: unknown = JSON.parse(charterText);
    const result = CharterV1.safeParse(json);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Read-only face of one fleet deployment: typed views over `FleetRegistry`, `FleetVotes`,
 * `TaskLedger`, and `AgoraGovernor`/`FleetHook`, built on top of a plain viem `PublicClient`.
 * Writes (opening a task, proposing, voting, queueing, executing) are out of this SDK's scope
 * here; callers sign and send those themselves with their own wallet client and the encoding
 * helpers in `actions.ts`/`description.ts`/`reason.ts`.
 */
export class FleetClient {
  readonly publicClient: PublicClient;
  readonly addresses: FleetAddresses;
  readonly chainId: number;

  constructor(opts: { rpcUrl: string; chainId: number; addresses: FleetAddresses }) {
    // Final review I2: a client is never built for a chain v1 refuses to operate on, so a
    // manifest that somehow named Base mainnet cannot get as far as a read, let alone a report
    // that presents another chain's ledger as this fleet's.
    assertAllowedChain(opts.chainId);
    this.addresses = opts.addresses;
    this.chainId = opts.chainId;
    const chain = defineChain({
      id: opts.chainId,
      name: `fleet-governance-${opts.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    });
    this.publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  }

  /**
   * Confirms the connected RPC really is the chain this client was configured for, and that the
   * chain is one v1 operates on. Final review M7: the client took `chainId` from the manifest and
   * never checked it, so only `FleetSigner.assertChain` ever compared configuration against
   * reality; a keeper, worker, or gateway pointed at the wrong RPC read a different chain's ledger
   * and reported its state as this fleet's. Call once at app startup, before the first read.
   */
  async assertChain(): Promise<void> {
    const actual = await this.publicClient.getChainId();
    if (actual !== this.chainId) {
      throw new Error(
        `connected RPC reports chain id ${actual}, this client is configured for chain id ${this.chainId}`,
      );
    }
    assertAllowedChain(actual);
  }

  async getTask(taskId: bigint): Promise<TaskView> {
    const [task, charterText] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.ledger,
        abi: taskLedgerAbi,
        functionName: "getTask",
        args: [taskId],
      }),
      this.publicClient.readContract({
        address: this.addresses.ledger,
        abi: taskLedgerAbi,
        functionName: "charterText",
        args: [taskId],
      }),
    ]);
    return {
      id: task.id,
      operator: task.operator,
      createdAt: task.createdAt,
      expiresAt: task.expiresAt,
      state: task.state as TaskState,
      charterVersion: task.charterVersion,
      charterHash: task.charterHash,
      decisionCount: task.decisionCount,
      openEscalations: task.openEscalations,
      charterText,
      charter: tryParseCharter(charterText),
    };
  }

  async exceptionVersion(taskId: bigint, payloadHash: Hex): Promise<number> {
    return this.publicClient.readContract({
      address: this.addresses.ledger,
      abi: taskLedgerAbi,
      functionName: "exceptionVersion",
      args: [taskId, payloadHash],
    });
  }

  async escalationVersion(taskId: bigint, payloadHash: Hex): Promise<number> {
    return this.publicClient.readContract({
      address: this.addresses.ledger,
      abi: taskLedgerAbi,
      functionName: "escalationVersion",
      args: [taskId, payloadHash],
    });
  }

  async isPaused(): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.addresses.ledger,
      abi: taskLedgerAbi,
      functionName: "paused",
    });
  }

  async getProposalState(proposalId: bigint): Promise<ProposalState> {
    const state = await this.publicClient.readContract({
      address: this.addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "state",
      args: [proposalId],
    });
    return state as ProposalState;
  }

  async getProposalVotes(proposalId: bigint): Promise<{ against: bigint; for: bigint; abstain: bigint }> {
    const [against, forVotes, abstain] = await this.publicClient.readContract({
      address: this.addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "proposalVotes",
      args: [proposalId],
    });
    return { against, for: forVotes, abstain };
  }

  async getQuorum(proposalId: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "quorum",
      args: [proposalId],
    });
  }

  async getProposalTiming(proposalId: bigint): Promise<{ snapshot: bigint; deadline: bigint; eta: bigint }> {
    const [snapshot, deadline, eta] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.governor,
        abi: agoraGovernorAbi,
        functionName: "proposalSnapshot",
        args: [proposalId],
      }),
      this.publicClient.readContract({
        address: this.addresses.governor,
        abi: agoraGovernorAbi,
        functionName: "proposalDeadline",
        args: [proposalId],
      }),
      this.publicClient.readContract({
        address: this.addresses.governor,
        abi: agoraGovernorAbi,
        functionName: "proposalEta",
        args: [proposalId],
      }),
    ]);
    return { snapshot, deadline, eta };
  }

  async getProposalId(t: Address[], v: bigint[], c: Hex[], descriptionHash: Hex): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "getProposalId",
      args: [t, v, c, descriptionHash],
    });
  }

  async hasVoted(proposalId: bigint, account: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "hasVoted",
      args: [proposalId, account],
    });
  }

  /**
   * Voting power for `account`. With `timepoint`, reads the governor's historical
   * `getVotes(account, timepoint)` (the same snapshot the governor itself checks). Without one,
   * reads the token's current `getVotes(account)` directly, because the governor's own
   * `getVotes` requires a timepoint strictly before the chain's current clock value
   * (`ERC5805FutureLookup`) and so cannot answer "how much voting power right now".
   */
  async getVotes(account: Address, timepoint?: bigint): Promise<bigint> {
    if (timepoint !== undefined) {
      return this.publicClient.readContract({
        address: this.addresses.governor,
        abi: agoraGovernorAbi,
        functionName: "getVotes",
        args: [account, timepoint],
      });
    }
    return this.publicClient.readContract({
      address: this.addresses.token,
      abi: fleetVotesAbi,
      functionName: "getVotes",
      args: [account],
    });
  }

  /** Resolve one identity without loading the entire electorate for every voter. */
  async getMember(account: Address): Promise<{ agentId: number; account: Address; manifest: string } | null> {
    const member = await this.publicClient.readContract({
      address: this.addresses.registry, abi: fleetRegistryAbi, functionName: "isMember", args: [account],
    });
    if (!member) return null;
    const id = await this.publicClient.readContract({
      address: this.addresses.registry, abi: fleetRegistryAbi, functionName: "idOf", args: [account],
    });
    const manifest = await this.publicClient.readContract({
      address: this.addresses.registry, abi: fleetRegistryAbi, functionName: "agentManifest", args: [id],
    });
    return { agentId: Number(id), account, manifest };
  }

  async listMembers(): Promise<{ agentId: number; account: Address; manifest: string }[]> {
    const count = await this.publicClient.readContract({
      address: this.addresses.registry,
      abi: fleetRegistryAbi,
      functionName: "memberCount",
    });
    const agentIds = Array.from({ length: Number(count) }, (_, i) => i);
    const result: { agentId: number; account: Address; manifest: string }[] = [];
    // Bound RPC fan-out for fleets with thousands of identities. Preserve agent-id order.
    for (let start = 0; start < agentIds.length; start += 32) {
      const batch = await Promise.all(agentIds.slice(start, start + 32).map(async (agentId) => {
        const [account, manifest] = await Promise.all([
          this.publicClient.readContract({
            address: this.addresses.registry,
            abi: fleetRegistryAbi,
            functionName: "accountOf",
            args: [BigInt(agentId)],
          }),
          this.publicClient.readContract({
            address: this.addresses.registry,
            abi: fleetRegistryAbi,
            functionName: "agentManifest",
            args: [BigInt(agentId)],
          }),
        ]);
        return { agentId, account, manifest };
      }));
      result.push(...batch);
    }
    return result;
  }

  /** Reads the governor's `ProposalCreated` log for `proposalId`. Every field on the event is
   *  non-indexed, so this scans the governor's whole log history and filters client-side; see
   *  docs/spec.md section 8, "reconstruction from chain data". */
  async getProposalCreated(proposalId: bigint): Promise<ProposalCreatedView> {
    const logs = await this.publicClient.getContractEvents({
      address: this.addresses.governor,
      abi: agoraGovernorAbi,
      eventName: "ProposalCreated",
      fromBlock: 0n,
      toBlock: "latest",
    });
    const log = logs.find((l) => l.args.proposalId === proposalId);
    if (!log || log.args.proposalId === undefined) {
      throw new Error(`no ProposalCreated log found for proposalId ${proposalId.toString()}`);
    }
    const args = log.args;
    return {
      proposalId,
      proposer: args.proposer as Address,
      targets: (args.targets ?? []) as readonly Address[],
      values: (args.values ?? []) as readonly bigint[],
      calldatas: (args.calldatas ?? []) as readonly Hex[],
      description: args.description ?? "",
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      txHash: log.transactionHash,
    };
  }

  /** Reads `VoteCast` logs for `proposalId`. `proposalId` is not indexed on this event, so the
   *  scan starts at the proposal's own creation block (from `getProposalCreated`) rather than
   *  genesis, since no vote can precede the proposal that opens voting on it. */
  async listVotes(proposalId: bigint): Promise<VoteCastView[]> {
    const created = await this.getProposalCreated(proposalId);
    const logs = await this.publicClient.getContractEvents({
      address: this.addresses.governor,
      abi: agoraGovernorAbi,
      eventName: "VoteCast",
      fromBlock: created.blockNumber,
      toBlock: "latest",
    });
    return logs
      .filter((l) => l.args.proposalId === proposalId)
      .map((l) => {
        const reason = l.args.reason ?? "";
        return {
          voter: l.args.voter as Address,
          proposalId,
          support: l.args.support as 0 | 1 | 2,
          weight: l.args.weight ?? 0n,
          reason,
          parsedReason: parseVoteReason(reason),
          blockNumber: l.blockNumber,
          logIndex: l.logIndex,
          txHash: l.transactionHash,
        };
      });
  }

  /** Reads every recorded decision for `taskId`: the stored `Decision` structs (via `getDecision`,
   *  which does not carry `summary`) joined against `DecisionRecorded` logs (indexed by `taskId`,
   *  which do) for `summary`, `blockNumber`, and `txHash`. */
  async listDecisions(taskId: bigint): Promise<DecisionView[]> {
    const task = await this.publicClient.readContract({
      address: this.addresses.ledger,
      abi: taskLedgerAbi,
      functionName: "getTask",
      args: [taskId],
    });
    const indices = Array.from({ length: task.decisionCount }, (_, i) => i);
    const [decisions, logs] = await Promise.all([
      Promise.all(
        indices.map((index) =>
          this.publicClient.readContract({
            address: this.addresses.ledger,
            abi: taskLedgerAbi,
            functionName: "getDecision",
            args: [taskId, index],
          }),
        ),
      ),
      this.publicClient.getContractEvents({
        address: this.addresses.ledger,
        abi: taskLedgerAbi,
        eventName: "DecisionRecorded",
        args: { taskId },
        fromBlock: 0n,
        toBlock: "latest",
      }),
    ]);
    return decisions.map((d) => {
      const log = logs.find((l) => l.args.index === d.index);
      if (!log) {
        throw new Error(`no DecisionRecorded log found for taskId ${taskId.toString()} index ${d.index}`);
      }
      return {
        taskId: d.taskId,
        index: d.index,
        kind: decisionKindFromUint8(d.kind),
        charterVersionBefore: d.charterVersionBefore,
        charterVersionAfter: d.charterVersionAfter,
        payloadHash: d.payloadHash,
        actionId: d.actionId,
        summary: log.args.summary ?? "",
        recordedAt: d.recordedAt,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      };
    });
  }

  async blockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async timestamp(): Promise<bigint> {
    const block = await this.publicClient.getBlock();
    return block.timestamp;
  }
}

/**
 * `Hooks.callHook`/`Hooks.staticCallHook` (the pinned Agora fork) discard every hook revert's
 * selector and arguments and re-revert with the bare, zero-argument `error HookCallFailed()`
 * (docs/compatibility-notes.md, "hook revert data is not preserved through Hooks.callHook").
 * `HookCallFailed` is declared inside `Hooks.sol` and re-exported through the governor's own ABI
 * (`agoraGovernorAbi`'s errors), so it is decodable from a `propose`/`castVote` simulation, but its
 * presence tells a caller only that FleetHook rejected the call, never which rule. `viem`'s
 * `toFunctionSelector` mis-signs an `AbiError` item passed as an object for this ABI (compare
 * against `cast sig "HookCallFailed()"` => 0xa9e35b2f); passing the bare string signature instead
 * takes the code path that gets it right, so that is what this computes from.
 */
const HOOK_CALL_FAILED_SELECTOR = toFunctionSelector("HookCallFailed()");

const HOOK_RULES = [
  "the proposer or voter is a registered fleet member",
  "the proposal targets exactly one TaskLedger.recordDecision call, value zero",
  "the description carries the #proposalTypeId=0 marker and is 1 to 4096 bytes",
  "the decision kind, charter text, and summary are within the ledger's bounds",
  "expectedVersion matches the task's current charter version",
  "there is enough task time left for voting delay + voting period + timelock delay + margin",
  "the vote reason is 1 to 1024 bytes and carries no extra params",
  "the proposer has no other unsettled proposal on this task",
] as const;

/**
 * Turns a thrown viem error from a governor `propose`/`castVote*` simulation or send into a
 * message a human can act on. When the revert is the governor's collapsed `HookCallFailed()`
 * (see above), names every FleetHook rule that could have fired, since the specific one cannot be
 * recovered from this call's revert data alone; the caller would need to simulate the hook
 * function directly (`eth_call` against `FleetHook`) to see the real inner error. For any other
 * decodable revert, names the error and its arguments. Falls back to the error's own message.
 */
export function explainRevert(error: unknown): string {
  if (error instanceof BaseError) {
    const revertError = error.walk((e) => e instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | undefined;
    if (revertError) {
      const errorName = revertError.data?.errorName;
      if (errorName === "HookCallFailed" || revertError.signature === HOOK_CALL_FAILED_SELECTOR) {
        return [
          "FleetHook rejected this call (HookCallFailed). The governor discards the hook's own revert " +
            "reason and re-reverts with the bare HookCallFailed() selector (docs/compatibility-notes.md), " +
            "so the specific rule cannot be read from this revert. It failed one of:",
          ...HOOK_RULES.map((rule) => `  - ${rule}`),
          "Simulate the hook call directly (eth_call against FleetHook with the same arguments) to recover " +
            "which rule actually fired.",
        ].join("\n");
      }
      if (errorName) {
        const args = revertError.data?.args ?? [];
        return `Reverted with ${errorName}(${args.map((a) => String(a)).join(", ")})`;
      }
      return revertError.shortMessage;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
