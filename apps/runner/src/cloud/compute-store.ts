import { z } from "zod";
import { CloudError, googleRequest } from "./google.js";
import { ComputeAllocation } from "./compute-policy.js";
import type { ComputeRecord } from "./compute-controller.js";

export const COMPUTE_BUCKET = "fleet-governance-control-449245570324";
const uuid = z.string().uuid();
const recordSchema = z.object({
  allocationId: uuid, phase: z.enum(["voting", "authorised", "halted"]),
  observedAt: z.number().int().nonnegative(), authorisedAt: z.number().int().nonnegative().optional(),
  haltedAt: z.number().int().nonnegative().optional(),
  reason: z.enum(["vote_failed", "approval_deadline", "allocation_expired", "unverifiable_vote", "allocation_mismatch"]).optional(),
  failedProposalId: z.string().regex(/^[0-9]+$/).optional(),
  blockNumber: z.string().regex(/^[0-9]+$/).optional(), blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  stopRequestedAt: z.number().int().nonnegative().optional(), stoppedAt: z.number().int().nonnegative().optional(),
  observedVmStatus: z.string().optional(),
}).strict().refine(value => value.phase !== "halted" || (value.reason && value.haltedAt !== undefined), "A halt requires a reason and timestamp.");

async function object(name: string): Promise<{ value: unknown; generation: string } | null> {
  try {
    const base = `storage/v1/b/${COMPUTE_BUCKET}/o/${encodeURIComponent(name)}`;
    const meta = await (await googleRequest("storage", base)).json() as { generation: string };
    if (!/^[0-9]+$/.test(meta.generation)) throw new Error("Invalid compute record generation.");
    const value: unknown = await (await googleRequest("storage", `${base}?alt=media&generation=${meta.generation}`)).json();
    return { value, generation: meta.generation };
  } catch (error) {
    if (error instanceof CloudError && error.status === 404) return null;
    throw error;
  }
}

export async function readComputeAllocation(): Promise<ComputeAllocation | null> {
  const active = await object("active.json");
  if (!active) return null;
  const { allocationId } = z.object({ allocationId: uuid }).strict().parse(active.value);
  const stored = await object(`allocations/${allocationId}.json`);
  if (!stored) throw new Error("Active compute allocation is missing.");
  const allocation = ComputeAllocation.parse(stored.value);
  if (allocation.allocationId !== allocationId) throw new Error("Compute allocation identity did not match.");
  return allocation;
}
export async function readComputeState(allocationId: string): Promise<{ value: ComputeRecord; generation: string } | null> {
  const stored = await object(`states/${uuid.parse(allocationId)}.json`);
  // The source is JSON, so optional keys cannot contain JavaScript undefined. Zod's
  // inferred optional types include it; the persisted record type uses absent keys.
  return stored ? { value: recordSchema.parse(stored.value) as ComputeRecord, generation: stored.generation } : null;
}
export async function isComputeRunBlocked(runId: string): Promise<boolean> {
  if (!/^run-[0-9a-f-]{36}$/.test(runId)) throw new Error("Invalid compute run identity.");
  return await object(`blocked-runs/${runId}.json`) !== null;
}
export async function readComputeEvidence(): Promise<unknown> {
  return (await object("evidence/latest.json"))?.value ?? null;
}
export async function readComputeObject(name: string): Promise<unknown> {
  return (await object(name))?.value ?? null;
}
export async function saveComputeState(value: ComputeRecord, generation: string): Promise<boolean> {
  const validated = recordSchema.parse(value);
  if (!/^[0-9]+$/.test(generation)) throw new Error("Invalid compute state generation.");
  try {
    await googleRequest("storage", `upload/storage/v1/b/${COMPUTE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(`states/${validated.allocationId}.json`)}&ifGenerationMatch=${generation}`, {
      method: "POST", body: JSON.stringify(validated),
    });
    return true;
  } catch (error) {
    if (error instanceof CloudError && error.status === 412) return false;
    throw error;
  }
}

/** Launcher and CI must consult this store, not worker-written status.json, before
 * restarting a worker. The worker has no permission to modify either allocation or halt. */
export async function assertComputeStartAllowed(): Promise<void> {
  if (await object("simulation-queue.json")) throw new Error("A protected simulation request owns this worker. Human recovery is required before a new run or restart.");
  const allocation = await readComputeAllocation();
  if (!allocation) return;
  const state = await readComputeState(allocation.allocationId);
  if (state?.value.phase === "halted" || Date.now() / 1000 >= allocation.stopAt) {
    throw new Error("Compute governance stopped this allocation. A human must authorise a new allocation before restarting the worker.");
  }
  // An armed allocation is owned by the supervisor. Wake is not an allocation renewal.
  throw new Error("This worker has an active compute allocation. Restart it through the governed allocation workflow.");
}
