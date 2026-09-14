import { decodeFunctionData, encodeFunctionData, getAbiItem, keccak256, toFunctionSelector, toHex } from "viem";
import type { Hex } from "viem";
import { taskLedgerAbi } from "@fleet/abi";
import { canonicalize, decisionKindToUint8 } from "@fleet/schemas";
import type { ActionDescriptor, DecisionKind } from "@fleet/schemas";

/**
 * Thrown by `decodeRecordDecision` for any calldata this SDK will not treat as a canonical
 * `TaskLedger.recordDecision` call: too short to carry a selector, the wrong selector, a static
 * head shorter than the six-word ABI head requires, or calldata that decodes but does not
 * re-encode to the identical bytes. Mirrors every rejection `FleetHook.decodeAction` makes onchain
 * (see docs/compatibility-notes.md, "Fix round 1: decodeAction minimum-length guard"), so a
 * proposal the SDK accepts is a proposal the hook accepts, and vice versa.
 */
export class MalformedCalldataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedCalldataError";
  }
}

const recordDecisionAbiItem = getAbiItem({ abi: taskLedgerAbi, name: "recordDecision" });
const RECORD_DECISION_SELECTOR = toFunctionSelector(recordDecisionAbiItem);

/** Selector (4 bytes) plus the six-word static head of (uint256,uint8,uint32,bytes32,string,string). */
const MIN_RECORD_DECISION_BYTES = 4 + 6 * 32;

const uint8ToDecisionKind: Record<number, DecisionKind> = Object.fromEntries(
  Object.entries(decisionKindToUint8).map(([kind, uint8]) => [uint8, kind as DecisionKind]),
);

function byteLength(data: Hex): number {
  return (data.length - 2) / 2;
}

/** Inverse of `decisionKindToUint8` (`@fleet/schemas`); throws for a value outside 0 to 4. */
export function decisionKindFromUint8(n: number): DecisionKind {
  const kind = uint8ToDecisionKind[n];
  if (kind === undefined) {
    throw new MalformedCalldataError(`decision kind uint8 ${n} is out of range`);
  }
  return kind;
}

export interface RecordDecisionAction {
  taskId: bigint;
  kind: DecisionKind;
  expectedVersion: number;
  payloadHash: Hex;
  newCharterText: string;
  summary: string;
}

/** Canonically encodes a `TaskLedger.recordDecision` call, byte for byte what the hook decodes. */
export function encodeRecordDecision(a: RecordDecisionAction): Hex {
  return encodeFunctionData({
    abi: taskLedgerAbi,
    functionName: "recordDecision",
    args: [a.taskId, decisionKindToUint8[a.kind], a.expectedVersion, a.payloadHash, a.newCharterText, a.summary],
  });
}

/**
 * Decodes `recordDecision` calldata, mirroring `FleetHook.decodeAction` exactly: reject calldata
 * shorter than the selector, reject the wrong selector, reject a static head shorter than the
 * six-word ABI head, decode, then re-encode and require byte-for-byte equality with the input.
 * A proposal whose calldata fails here will also fail `beforePropose` onchain.
 */
export function decodeRecordDecision(data: Hex): RecordDecisionAction {
  if (byteLength(data) < 4) {
    throw new MalformedCalldataError(`calldata is ${byteLength(data)} bytes, shorter than the 4-byte selector`);
  }
  const selector = data.slice(0, 10).toLowerCase();
  if (selector !== RECORD_DECISION_SELECTOR.toLowerCase()) {
    throw new MalformedCalldataError(
      `selector ${data.slice(0, 10)} does not match TaskLedger.recordDecision (${RECORD_DECISION_SELECTOR})`,
    );
  }
  if (byteLength(data) < MIN_RECORD_DECISION_BYTES) {
    throw new MalformedCalldataError(
      `calldata is ${byteLength(data)} bytes, shorter than the six-word static head (${MIN_RECORD_DECISION_BYTES} bytes)`,
    );
  }

  let taskId: bigint;
  let kindUint8: number;
  let expectedVersion: number;
  let payloadHash: Hex;
  let newCharterText: string;
  let summary: string;
  try {
    const decoded = decodeFunctionData({ abi: taskLedgerAbi, data });
    if (decoded.functionName !== "recordDecision") {
      throw new MalformedCalldataError(`decoded function ${decoded.functionName} is not recordDecision`);
    }
    [taskId, kindUint8, expectedVersion, payloadHash, newCharterText, summary] = decoded.args;
  } catch (err) {
    if (err instanceof MalformedCalldataError) throw err;
    throw new MalformedCalldataError(
      `could not decode recordDecision calldata: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const kind = decisionKindFromUint8(kindUint8);

  const reencoded = encodeRecordDecision({ taskId, kind, expectedVersion, payloadHash, newCharterText, summary });
  if (reencoded.toLowerCase() !== data.toLowerCase()) {
    throw new MalformedCalldataError("calldata does not re-encode to identical bytes (non-canonical encoding)");
  }

  return { taskId, kind, expectedVersion, payloadHash, newCharterText, summary };
}

/** keccak256(utf8(canonicalize(d))), the payload hash for a CHOOSE_PATH/GRANT_EXCEPTION action descriptor. */
export function payloadHashForAction(d: ActionDescriptor): Hex {
  return keccak256(toHex(canonicalize(d)));
}

/** keccak256(utf8(text)), matching `TaskLedger._applyAmendment`'s `keccak256(bytes(newCharterText))`. */
export function payloadHashForCharter(charterText: string): Hex {
  return keccak256(toHex(charterText));
}

/** keccak256(utf8(canonicalize(pathDescriptor))), for CHOOSE_PATH payloads that are not ActionDescriptor. */
export function payloadHashForPath(pathDescriptor: unknown): Hex {
  return keccak256(toHex(canonicalize(pathDescriptor)));
}

/** Onchain ballot values (docs/spec.md section 6): Against 0, For 1, Abstain 2. */
export function supportToUint8(s: "FOR" | "AGAINST" | "ABSTAIN"): 0 | 1 | 2 {
  switch (s) {
    case "AGAINST":
      return 0;
    case "FOR":
      return 1;
    case "ABSTAIN":
      return 2;
  }
}
