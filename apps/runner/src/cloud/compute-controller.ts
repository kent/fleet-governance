import { evaluateComputeAllocation, type ComputeAllocation, type ComputeObservation, type ComputeState } from "./compute-policy.js";
import { guardianObservation, type GuardianObservation } from "./guardian-evidence.js";

export type ComputeRecord = ComputeState & {
  stopRequestedAt?: number;
  stoppedAt?: number;
  observedVmStatus?: string;
  checkedAt?: number;
  observations?: GuardianObservation[];
  stopAcceptedAt?: number;
  stopOperationId?: string;
};
export type ComputeControllerDeps = {
  readState(): Promise<{ value: ComputeRecord; generation: string } | null>;
  /** Compare-and-swap in a store the agent worker cannot write. False means retry. */
  saveState(value: ComputeRecord, generation: string): Promise<boolean>;
  observe(): Promise<ComputeObservation>;
  readVm(): Promise<{ id: string; status: string }>;
  stopVm(): Promise<void | { operationId: string }>;
  now(): number;
};

/** Runs outside the worker VM. Never starts, resizes or extends compute. The only
 * cloud mutation exposed to this code is stopping the instance fixed in the allocation. */
export async function reconcileComputeAllocation(
  allocation: ComputeAllocation,
  deps: ComputeControllerDeps,
): Promise<ComputeRecord> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const saved = await deps.readState();
    let now = deps.now();
    let observation: ComputeObservation | null = null;
    // A halt and the hard deadline do not depend on a healthy RPC or on new votes.
    if (saved?.value.phase !== "halted" && now < allocation.stopAt) {
      try { observation = await deps.observe(); } catch { /* Unverifiable authority halts. */ }
    }
    now = deps.now();
    let next: ComputeRecord = evaluateComputeAllocation(allocation, saved?.value ?? null, observation, now);
    const vm = await deps.readVm();
    if (vm.id !== allocation.instanceId) {
      // Never apply an old policy to a replacement VM that happens to reuse its name.
      next = { allocationId: allocation.allocationId, phase: "halted", observedAt: now,
        haltedAt: saved?.value.haltedAt ?? now, reason: "allocation_mismatch", observedVmStatus: "INSTANCE_REPLACED", checkedAt: now };
      next.observations = [...(saved?.value.observations ?? []), guardianObservation(allocation, observation, next, vm, now)].slice(-64);
      if (!await deps.saveState(next, saved?.generation ?? "0")) continue;
      return next;
    }
    next = { ...next, observedVmStatus: vm.status, checkedAt: now,
      observations: saved?.value.phase === "halted" ? saved.value.observations ?? [] :
        [...(saved?.value.observations ?? []), guardianObservation(allocation, observation, next, vm, now)].slice(-64) };
    if (next.phase !== "halted") {
      if (!await deps.saveState(next, saved?.generation ?? "0")) continue;
      return next;
    }
    if (vm.status === "TERMINATED") {
      next.stoppedAt = saved?.value.stoppedAt ?? now;
      if (!await deps.saveState(next, saved?.generation ?? "0")) continue;
      return next;
    }
    // The durable stop precedes the API call. A lost response is retried on the next
    // observation. STOPPING is not reported as stopped, and a later restart is stopped again.
    delete next.stoppedAt;
    next.stopRequestedAt = saved?.value.stopRequestedAt ?? now;
    if (!await deps.saveState(next, saved?.generation ?? "0")) continue;
    if (vm.status === "RUNNING") {
      const operation = await deps.stopVm();
      // API acceptance is separate from intent and from observing TERMINATED.
      // Never replace a concurrent state write using an outdated generation.
      const latest = await deps.readState();
      if (latest?.value.phase === "halted" && latest.value.allocationId === allocation.allocationId) {
        const accepted = { ...latest.value, stopAcceptedAt: latest.value.stopAcceptedAt ?? deps.now(),
          ...(operation ? { stopOperationId: operation.operationId } : {}) };
        if (await deps.saveState(accepted, latest.generation)) next = accepted;
      }
    }
    return next;
  }
  throw new Error("Compute state changed concurrently; retry reconciliation.");
}
