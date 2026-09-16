import { randomUUID } from "node:crypto";
import { createPublicClient, http, keccak256, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { logBoundedHttp } from "@fleet/sdk";
import { z } from "zod";
import { ComputeAllocation, ProposalDiscovery } from "./compute-policy.js";
import { discoverTaskProposals } from "./proposal-discovery.js";
import { COMPUTE_BUCKET, isComputeRunBlocked, readComputeAllocation, readComputeState } from "./compute-store.js";
import { CloudError, googleRequest, readSecret, writeObject } from "./google.js";

export const COMPUTE_TARGET = "compute/v1/projects/fleet-governance/zones/us-central1-a/instances/fleet-research";
export const AllocationRequest = z.object({
  runId: z.string().regex(/^run-[0-9a-f-]{36}$/),
  governor: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  requiredProposalIds: z.array(z.string().regex(/^(0|[1-9][0-9]*)$/)).max(64),
  checkpoints: z.array(z.object({ proposalId: z.string().regex(/^(0|[1-9][0-9]*)$/), approvalDeadline: z.number().int().nonnegative().safe() }).strict()).min(1).max(8).optional(),
  discovery: ProposalDiscovery.optional(),
  stopAt: z.number().int().nonnegative().safe().optional(),
  approvalSeconds: z.number().int().min(60).max(1800).default(600),
}).strict().refine(request => request.discovery ? request.requiredProposalIds.length === 0 && !request.checkpoints && !!request.stopAt
  : request.requiredProposalIds.length > 0 && request.stopAt === undefined, "Discovery requires a fixed expiry and no preselected proposals.");

export type NativeVm = {
  id: string; status: string; lastStartTimestamp: string;
  scheduling: { automaticRestart: boolean; instanceTerminationAction: string };
  resourceStatus?: { scheduling?: { terminationTimestamp?: string } };
};
export function nativeStopAt(vm: NativeVm, now: number): number {
  const expiry = Date.parse(vm.resourceStatus?.scheduling?.terminationTimestamp ?? "") / 1000;
  if (vm.status !== "RUNNING" || vm.scheduling.automaticRestart !== false
    || vm.scheduling.instanceTerminationAction !== "STOP"
    || !Number.isFinite(expiry) || expiry <= now || expiry - now > 14400) {
    throw new Error("Arming requires a running VM with automatic restart disabled and a native STOP deadline within four hours.");
  }
  return Math.floor(expiry);
}

export async function writeControlObject(name: string, value: unknown): Promise<void> {
  await googleRequest("storage", `upload/storage/v1/b/${COMPUTE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=0`, {
    method: "POST", body: JSON.stringify(value),
  });
}

/** Human/CI only. No worker or controller identity can write these objects. The
 * create-only active pointer is the lock: an armed or halted allocation cannot be replaced. */
export async function armComputeAllocation(input: unknown): Promise<ComputeAllocation> {
  const request = AllocationRequest.parse(input);
  if (await isComputeRunBlocked(request.runId)) throw new Error("This run was permanently retired. A new allocation requires a new run identity.");
  if (await readComputeAllocation()) throw new Error("A compute allocation is already armed. Operator recovery is required.");
  const rpc = await readSecret("fleet-base-sepolia-rpc-url");
  const client = createPublicClient({ chain: baseSepolia, transport: request.discovery
    ? logBoundedHttp(rpc, BigInt(request.discovery.startBlock)) : http(rpc, { timeout: 10000, retryCount: 1 }) });
  if (await client.getChainId() !== 84532) throw new Error("Compute governance requires Base Sepolia.");
  const code = await client.getCode({ address: request.governor as Address });
  if (!code || code === "0x") throw new Error("Governor has no bytecode.");
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as NativeVm;
  const now = Math.floor(Date.now() / 1000);
  const nativeExpiry = nativeStopAt(vm, now);
  const stopAt = request.stopAt ?? nativeExpiry;
  if (stopAt > nativeExpiry || stopAt <= now) throw new Error("Allocation expiry exceeds native compute authority.");
  const allocation = ComputeAllocation.parse({
    schema: "fleet.compute-allocation.v1", allocationId: randomUUID(),
    runId: request.runId, project: "fleet-governance", zone: "us-central1-a",
    instance: "fleet-research", instanceId: vm.id, issuedAt: now,
    approvalDeadline: request.discovery ? stopAt : request.checkpoints?.at(-1)?.approvalDeadline ?? now + request.approvalSeconds, stopAt, nativeStopAt: nativeExpiry,
    chainId: 84532, governor: request.governor, governorCodeHash: keccak256(code),
    requiredProposalIds: request.requiredProposalIds, ...(request.checkpoints ? { checkpoints: request.checkpoints } : {}),
    ...(request.discovery ? { discovery: request.discovery } : {}), maxObservationAgeSeconds: 120,
  });
  if (!request.discovery && allocation.approvalDeadline > now + 1800) throw new Error("Checkpoint approvals must finish within 30 minutes.");
  if (request.discovery) {
    const block = await client.getBlockNumber();
    if (block < 2n || (await discoverTaskProposals(client, allocation, block - 2n)).length !== 0) throw new Error("A new run must begin without proposals or payments.");
  }
  await writeControlObject(`allocations/${allocation.allocationId}.json`, allocation);
  await writeControlObject("active.json", { allocationId: allocation.allocationId });
  return allocation;
}

/** Called only after the workflow pauses Scheduler, deletes the controller service,
 * waits beyond its 120-second request timeout for existing requests to drain, and verifies Compute Engine TERMINATED.
 * Recovery is a separate human authorisation, never an agent vote or routine Wake. */
export async function releaseComputeAllocation(expectedId: string): Promise<void> {
  const allocation = await readComputeAllocation();
  if (!allocation || allocation.allocationId !== z.string().uuid().parse(expectedId)) throw new Error("Recovery requires the exact current allocation ID.");
  const saved = await readComputeState(allocation.allocationId);
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as NativeVm;
  if (vm.id !== allocation.instanceId || vm.status !== "TERMINATED" || saved?.value.phase !== "halted") {
    throw new Error("Recovery requires a durable halt and the same VM verified TERMINATED.");
  }
  // Permanent run-level tombstone survives releasing the active allocation pointer.
  if (!await isComputeRunBlocked(allocation.runId)) {
    await writeControlObject(`blocked-runs/${allocation.runId}.json`, { allocationId: allocation.allocationId, runId: allocation.runId });
  }
  // Queue status is secondary evidence, not the latch. Mark it terminal before a
  // fresh human allocation can start the worker, so a power loss cannot replay it.
  await writeObject(`demo/runs/${allocation.runId}/status.json`, {
    runId: allocation.runId, phase: "failed", terminal: true, updatedAt: new Date().toISOString(),
    message: `Compute allocation ${allocation.allocationId} halted: ${saved.value.reason}. Human recovery does not resume this run.`,
  });
  // A retry after the audit write must still be able to finish releasing the pointer.
  await googleRequest("storage", `upload/storage/v1/b/${COMPUTE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(`released/${allocation.allocationId}.json`)}`, { method: "POST", body: JSON.stringify({
    allocationId: allocation.allocationId, runId: allocation.runId, releasedAt: new Date().toISOString(),
    operator: process.env.GITHUB_ACTOR, workflowRun: process.env.GITHUB_RUN_ID,
    state: saved.value, observedVmStatus: vm.status,
  }) });
  const object = `storage/v1/b/${COMPUTE_BUCKET}/o/active.json`;
  const meta = await (await googleRequest("storage", object)).json() as { generation: string };
  if (!/^[0-9]+$/.test(meta.generation)) throw new Error("Invalid active allocation generation.");
  const current = await (await googleRequest("storage", `${object}?alt=media&generation=${meta.generation}`)).json() as { allocationId: string };
  if (current.allocationId !== allocation.allocationId) throw new Error("Active allocation changed during recovery.");
  // Release the matching human request only after the permanent run tombstone
  // exists and the worker is verified off. Its work and evidence remain immutable.
  const queueObject = `storage/v1/b/${COMPUTE_BUCKET}/o/simulation-queue.json`;
  try {
    const queueMeta = await (await googleRequest("storage", queueObject)).json() as { generation: string };
    if (!/^[0-9]+$/.test(queueMeta.generation)) throw new Error("Invalid simulation generation.");
    const queue = await (await googleRequest("storage", `${queueObject}?alt=media&generation=${queueMeta.generation}`)).json() as { runId: string };
    if (queue.runId !== allocation.runId) throw new Error("A different simulation owns the queue.");
    await googleRequest("storage", `${queueObject}?ifGenerationMatch=${queueMeta.generation}`, { method: "DELETE" });
  } catch (error) { if (!(error instanceof CloudError && error.status === 404)) throw error; }
  await googleRequest("storage", `${object}?ifGenerationMatch=${meta.generation}`, { method: "DELETE" });
}
