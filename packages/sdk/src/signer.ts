import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  http,
  keccak256,
  toFunctionSelector,
  toHex,
} from "viem";
import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agoraGovernorAbi, fleetVotesAbi } from "@fleet/abi";
import type { DecisionKind } from "@fleet/schemas";
import { decodeRecordDecision, encodeRecordDecision } from "./actions.js";
import { explainRevert } from "./client.js";
import type { NonceManager } from "./nonce.js";

/**
 * The addresses and chain `FleetSigner` is allowed to touch. `ledger` is where every proposal's
 * single inner call (`TaskLedger.recordDecision`) must target; it is part of the policy, not a
 * `propose()` argument, so a caller of `propose` can never redirect a proposal at some other
 * contract.
 */
export type SignerPolicy = {
  chainId: number;
  governor: Address;
  ledger: Address;
  token: Address;
  maxFeePerGasWei?: bigint;
  maxGas?: bigint;
};

export type PolicyViolationCode = "CHAIN" | "TARGET" | "SELECTOR" | "VALUE" | "SIZE" | "RAW_CALLDATA";

/** Thrown before any signing or sending when a call `FleetSigner` was asked to make would fall
 *  outside its policy. Every check that can throw this runs client-side, ahead of simulation. */
export class PolicyViolation extends Error {
  readonly code: PolicyViolationCode;

  constructor(code: PolicyViolationCode, message: string) {
    super(message);
    this.name = "PolicyViolation";
    this.code = code;
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Throws `PolicyViolation("SIZE", …)` when `value`'s UTF-8 byte length falls outside
 *  `[minBytes, maxBytes]`. Exported so the byte-bound enforcement is directly testable. */
export function assertSize(field: string, value: string, minBytes: number, maxBytes: number): void {
  const bytes = byteLength(value);
  if (bytes < minBytes || bytes > maxBytes) {
    throw new PolicyViolation("SIZE", `${field} is ${bytes} bytes, must be between ${minBytes} and ${maxBytes} bytes`);
  }
}

const PROPOSE_SELECTOR = toFunctionSelector("propose(address[],uint256[],bytes[],string)");
const CAST_VOTE_SELECTOR = toFunctionSelector("castVoteWithReason(uint256,uint8,string)");
const DELEGATE_SELECTOR = toFunctionSelector("delegate(address)");

type AllowedCall = { target: Address; abi: Abi; functionName: string };

function allowedCalls(policy: SignerPolicy): Map<Hex, AllowedCall> {
  return new Map<Hex, AllowedCall>([
    [PROPOSE_SELECTOR, { target: policy.governor, abi: agoraGovernorAbi as Abi, functionName: "propose" }],
    [
      CAST_VOTE_SELECTOR,
      { target: policy.governor, abi: agoraGovernorAbi as Abi, functionName: "castVoteWithReason" },
    ],
    [DELEGATE_SELECTOR, { target: policy.token, abi: fleetVotesAbi as Abi, functionName: "delegate" }],
  ]);
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** A single planned contract call, described the same way regardless of which of `propose`,
 *  `castVoteWithReason`, or `delegate` built it. */
export type PlannedCall = {
  chainId: number;
  target: Address;
  value: bigint;
  data: Hex;
};

/**
 * The one gate every `FleetSigner` write passes through before it is simulated or signed. Checks,
 * in order: the call declares the policy's chain (`CHAIN`); its 4-byte selector is one of
 * `propose`/`castVoteWithReason`/`delegate` (`SELECTOR`); its target is the policy's configured
 * contract for that function (`TARGET`); its value is zero (`VALUE`); and its calldata decodes,
 * then re-encodes, to the identical bytes for that function (`RAW_CALLDATA`). `FleetSigner`
 * always builds calldata itself from typed arguments via `encodeFunctionData`, so this last check
 * only ever fires if a future change starts passing calldata through unchecked.
 *
 * Exported (and taking a plain `PlannedCall` rather than a live signer) so every rejection path
 * is directly unit-testable against a fabricated call, without a transport.
 */
export function checkPolicy(policy: SignerPolicy, call: PlannedCall): void {
  if (call.chainId !== policy.chainId) {
    throw new PolicyViolation(
      "CHAIN",
      `call declares chain id ${call.chainId}, policy is configured for chain id ${policy.chainId}`,
    );
  }

  const selector = call.data.slice(0, 10).toLowerCase() as Hex;
  const rule = allowedCalls(policy).get(selector);
  if (!rule) {
    throw new PolicyViolation(
      "SELECTOR",
      `selector ${selector} is not propose, castVoteWithReason, or delegate`,
    );
  }

  if (!sameAddress(call.target, rule.target)) {
    throw new PolicyViolation(
      "TARGET",
      `target ${call.target} is not the policy's configured contract for ${rule.functionName} (expected ${rule.target})`,
    );
  }

  if (call.value !== 0n) {
    throw new PolicyViolation("VALUE", `value ${call.value.toString()} is non-zero; FleetSigner never sends value`);
  }

  try {
    const decoded = decodeFunctionData({ abi: rule.abi, data: call.data });
    const reencoded = encodeFunctionData({ abi: rule.abi, functionName: decoded.functionName, args: decoded.args });
    if (reencoded.toLowerCase() !== call.data.toLowerCase()) {
      throw new Error("re-encoded calldata does not match the original bytes");
    }
  } catch (err) {
    throw new PolicyViolation(
      "RAW_CALLDATA",
      `calldata for ${rule.functionName} does not decode canonically: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * A policy-checked wrapper around a viem local-account wallet client. `FleetSigner` can only
 * call `propose`/`castVoteWithReason` on the policy's governor and `delegate` on the policy's
 * token, always with zero value and typed, size-bounded arguments it encodes itself. There is
 * deliberately no method that sends raw calldata, signs an arbitrary message, or targets any
 * other contract.
 *
 * Every write: validates argument sizes, confirms the connected chain matches the policy
 * (`CHAIN`), builds the calldata and runs it through `checkPolicy`, simulates it first so a hook
 * rejection surfaces as a clear message via `explainRevert` rather than an opaque revert, reserves
 * a nonce from the injected `NonceManager`, sends, and commits (or releases, on failure) the
 * reservation.
 */
export class FleetSigner {
  readonly address: Address;
  private readonly policy: SignerPolicy;
  private readonly nonces: NonceManager;
  private readonly wallet: WalletClient;
  private readonly publicClient: PublicClient;

  constructor(opts: { privateKey: Hex; rpcUrl: string; policy: SignerPolicy; nonces: NonceManager }) {
    const account = privateKeyToAccount(opts.privateKey);
    this.address = account.address;
    this.policy = opts.policy;
    this.nonces = opts.nonces;
    const chain = defineChain({
      id: opts.policy.chainId,
      name: `fleet-signer-${opts.policy.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    });
    this.wallet = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
    this.publicClient = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  }

  private async assertChain(): Promise<void> {
    const actual = await this.publicClient.getChainId();
    if (actual !== this.policy.chainId) {
      throw new PolicyViolation(
        "CHAIN",
        `connected RPC reports chain id ${actual}, policy is configured for chain id ${this.policy.chainId}`,
      );
    }
  }

  /** Runs `checkPolicy`, simulates, reserves a nonce, sends, and commits/releases it. Shared by
   *  all three public writes; each supplies its own already-encoded, already-size-checked call. */
  private async simulateAndSend(call: { target: Address; abi: Abi; functionName: string; args: readonly unknown[]; data: Hex }): Promise<Hex> {
    checkPolicy(this.policy, { chainId: this.policy.chainId, target: call.target, value: 0n, data: call.data });

    let request: Record<string, unknown>;
    try {
      const simulated = (await this.publicClient.simulateContract({
        account: this.wallet.account,
        address: call.target,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
        value: 0n,
      } as never)) as { request: Record<string, unknown> };
      request = simulated.request;
    } catch (err) {
      throw new Error(explainRevert(err), { cause: err });
    }

    const reservation = await this.nonces.reserve(this.address);
    try {
      const txHash = await this.wallet.writeContract({
        ...request,
        nonce: reservation.nonce,
        ...(this.policy.maxFeePerGasWei !== undefined ? { maxFeePerGas: this.policy.maxFeePerGasWei } : {}),
        ...(this.policy.maxGas !== undefined ? { gas: this.policy.maxGas } : {}),
      } as never);
      await reservation.commit(txHash);
      return txHash;
    } catch (err) {
      reservation.release();
      throw err;
    }
  }

  /** Proposes a `TaskLedger.recordDecision` decision against the policy's `ledger`, from the
   *  policy's `governor`. Predicts the resulting proposal id via `getProposalId` before sending,
   *  so the caller never has to reconstruct it from logs afterward. */
  async propose(input: {
    taskId: bigint;
    kind: DecisionKind;
    expectedVersion: number;
    payloadHash: Hex;
    newCharterText: string;
    summary: string;
    description: string;
  }): Promise<{ txHash: Hex; proposalId: bigint }> {
    assertSize("description", input.description, 1, 4096);
    assertSize("newCharterText", input.newCharterText, 0, 8192);
    // TaskLedger (and the spec) only bound summary from above ("at most 1,024 bytes"); an empty
    // summary is a content-quality concern for the caller, not a policy violation here.
    assertSize("summary", input.summary, 0, 1024);
    await this.assertChain();

    const calldata = encodeRecordDecision({
      taskId: input.taskId,
      kind: input.kind,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      newCharterText: input.newCharterText,
      summary: input.summary,
    });
    try {
      decodeRecordDecision(calldata);
    } catch (err) {
      throw new PolicyViolation(
        "RAW_CALLDATA",
        `built recordDecision calldata failed its own canonical round-trip: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const targets = [this.policy.ledger];
    const values = [0n];
    const calldatas = [calldata];
    const descriptionHash = keccak256(toHex(input.description));

    const proposalId = await this.publicClient.readContract({
      address: this.policy.governor,
      abi: agoraGovernorAbi,
      functionName: "getProposalId",
      args: [targets, values, calldatas, descriptionHash],
    });

    const data = encodeFunctionData({
      abi: agoraGovernorAbi,
      functionName: "propose",
      args: [targets, values, calldatas, input.description],
    });
    const txHash = await this.simulateAndSend({
      target: this.policy.governor,
      abi: agoraGovernorAbi as Abi,
      functionName: "propose",
      args: [targets, values, calldatas, input.description],
      data,
    });

    return { txHash, proposalId };
  }

  async castVoteWithReason(input: { proposalId: bigint; support: 0 | 1 | 2; reason: string }): Promise<{ txHash: Hex }> {
    assertSize("reason", input.reason, 1, 1024);
    await this.assertChain();

    const data = encodeFunctionData({
      abi: agoraGovernorAbi,
      functionName: "castVoteWithReason",
      args: [input.proposalId, input.support, input.reason],
    });
    const txHash = await this.simulateAndSend({
      target: this.policy.governor,
      abi: agoraGovernorAbi as Abi,
      functionName: "castVoteWithReason",
      args: [input.proposalId, input.support, input.reason],
      data,
    });
    return { txHash };
  }

  async delegate(delegatee: Address): Promise<{ txHash: Hex }> {
    await this.assertChain();

    const data = encodeFunctionData({ abi: fleetVotesAbi, functionName: "delegate", args: [delegatee] });
    const txHash = await this.simulateAndSend({
      target: this.policy.token,
      abi: fleetVotesAbi as Abi,
      functionName: "delegate",
      args: [delegatee],
      data,
    });
    return { txHash };
  }
}
