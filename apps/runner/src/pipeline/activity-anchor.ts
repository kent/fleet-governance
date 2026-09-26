import { concat, decodeAbiParameters, encodeAbiParameters, keccak256, slice, toHex, type Hex } from "viem";
import { verifyActivity, type ActivityAttestation } from "./activity-attestation.js";

/** An agent's own wallet posts the head of its hash-chained activity log onchain, in a
 * zero-value transaction to itself. One anchor commits every earlier record, because each
 * record names the digest before it. No contract is involved, so nothing can reject it. */
export const ANCHOR_SCHEMA = "fleet.activity.anchor.v1";
const TAG = slice(keccak256(toHex(ANCHOR_SCHEMA)), 0, 4);
const LAYOUT = [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }] as const;

export type ActivityAnchor = { agentId: number; address: Hex; sequence: number; digest: Hex; txHash: Hex; blockNumber?: string; at?: string };

export const runHash = (runId: string) => keccak256(toHex(runId));

export function encodeAnchor(input: { runId: string; taskId: string; sequence: number; digest: Hex }): Hex {
  return concat([TAG, encodeAbiParameters(LAYOUT, [runHash(input.runId), BigInt(input.taskId), BigInt(input.sequence), input.digest])]);
}

export function decodeAnchor(data: Hex): { runHash: Hex; taskId: string; sequence: number; digest: Hex } | null {
  try {
    if (slice(data, 0, 4) !== TAG) return null;
    const [run, taskId, sequence, digest] = decodeAbiParameters(LAYOUT, slice(data, 4));
    return { runHash: run, taskId: taskId.toString(), sequence: Number(sequence), digest };
  } catch { return null; }
}

/** Checks one anchor transaction against the signed log: the agent's own wallet sent it to
 * itself, it names this run and task, and the digest it carries is the signed record at that
 * sequence, reached by an unbroken hash chain from the agent's first record. */
export async function verifyAnchor(tx: { from: Hex; to: Hex | null; value: bigint; input: Hex },
  input: { runId: string; taskId: string; address: Hex; activity: ActivityAttestation[] }): Promise<{ ok: true; sequence: number } | { ok: false; reason: string }> {
  const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  if (!same(tx.from, input.address) || !same(tx.to, input.address) || tx.value !== 0n) return { ok: false, reason: "Not a zero-value transaction from the agent to itself." };
  const anchor = decodeAnchor(tx.input);
  if (!anchor) return { ok: false, reason: "Transaction data is not an activity anchor." };
  if (anchor.runHash !== runHash(input.runId) || anchor.taskId !== input.taskId) return { ok: false, reason: "Anchor names a different run or task." };
  const records = input.activity.filter(r => same(r.address, input.address)).sort((a, b) => a.sequence - b.sequence);
  let previous: Hex = `0x${"0".repeat(64)}`;
  for (const [index, record] of records.entries()) {
    if (record.sequence !== index || record.previousHash !== previous || !await verifyActivity(record)) return { ok: false, reason: `Signed log breaks at sequence ${index}.` };
    if (record.sequence === anchor.sequence) {
      return record.digest === anchor.digest ? { ok: true, sequence: anchor.sequence } : { ok: false, reason: "Anchored digest differs from the signed record." };
    }
    previous = record.digest;
  }
  return { ok: false, reason: "No signed record at the anchored sequence." };
}
