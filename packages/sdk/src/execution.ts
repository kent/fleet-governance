import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, toHex } from "viem";
import type { Hex } from "viem";
import { fleetExecutorAbi } from "@fleet/abi";
import { DecisionV1, ExecutionPermitV1 } from "@fleet/schemas";

const permitTuple = {
  type: "tuple",
  components: [
    { name: "taskId", type: "uint256" }, { name: "charterVersion", type: "uint32" },
    { name: "actor", type: "address" }, { name: "target", type: "address" },
    { name: "targetCodeHash", type: "bytes32" }, { name: "dataHash", type: "bytes32" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
  ],
} as const;

/** The exact Solidity struct. The public description carries the full calldata, whose hash
 * enters the permit; target execution is always CALL with zero ETH, never delegatecall. */
export function executionPermitArgs(input: ExecutionPermitV1) {
  const p = ExecutionPermitV1.parse(input);
  return { taskId: BigInt(p.taskId), charterVersion: p.charterVersion, actor: p.actor as Hex,
    target: p.target as Hex, targetCodeHash: p.targetCodeHash as Hex, dataHash: keccak256(p.data as Hex),
    nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) };
}

export function payloadHashForExecution(input: ExecutionPermitV1): Hex {
  const p = ExecutionPermitV1.parse(input);
  return keccak256(encodeAbiParameters([
    { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, permitTuple,
  ], [keccak256(toHex(p.schema)), BigInt(p.chainId), p.executor as Hex, p.ledger as Hex, executionPermitArgs(p)]));
}

export function encodeExecutePermit(input: ExecutionPermitV1): Hex {
  const p = ExecutionPermitV1.parse(input);
  return encodeFunctionData({ abi: fleetExecutorAbi, functionName: "execute", args: [executionPermitArgs(p), p.data as Hex] });
}

/** Reject trailing bytes, noncanonical tuples and hidden/mismatched target calldata. */
export function decodeExecutePermit(data: Hex) {
  const call = decodeFunctionData({ abi: fleetExecutorAbi, data });
  if (call.functionName !== "execute") throw new Error("expected FleetExecutor.execute");
  const [permit, targetData] = call.args;
  const encoded = encodeFunctionData({ abi: fleetExecutorAbi, functionName: "execute", args: call.args });
  if (encoded.toLowerCase() !== data.toLowerCase()) throw new Error("noncanonical execute calldata");
  if (targetData.length < 10 || targetData.length > 16386 || keccak256(targetData) !== permit.dataHash) {
    throw new Error("execution calldata length or hash mismatch");
  }
  if (permit.taskId === 0n || permit.charterVersion === 0) throw new Error("execution requires an existing task and charter");
  return { permit, data: targetData };
}

export function decisionForExecution(input: {
  permit: ExecutionPermitV1; proposerAgentId: number; summary: string; rationale: string;
  assumptions?: string[]; riskFlags?: string[];
}): DecisionV1 {
  const execution = ExecutionPermitV1.parse(input.permit);
  return DecisionV1.parse({ schema: "fleet.decision.v1", taskId: execution.taskId, kind: "GRANT_EXCEPTION",
    expectedVersion: execution.charterVersion, payloadHash: payloadHashForExecution(execution),
    proposerAgentId: input.proposerAgentId, execution, summary: input.summary, rationale: input.rationale,
    assumptions: input.assumptions ?? [], riskFlags: input.riskFlags ?? [] });
}
