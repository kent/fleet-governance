import { reconcileComputeAllocation } from "./compute-controller.js";
import { observeComputeApproval } from "./compute-observer.js";
import { readComputeAllocation, readComputeState, saveComputeState } from "./compute-store.js";
import { googleRequest, readSecret } from "./google.js";
import { serveReconcile } from "./reconcile-server.js";

let rpc: string | undefined;
/** The Guardian. Invoked by Cloud Scheduler using its own Cloud Run invoker identity. There
 * is no worker-controlled target, allocation update, resource extension or start endpoint.
 * A rejected or lost API call is not a stopped VM: Scheduler retries, and the VM's native
 * termination time is the fallback if this service is down. */
serveReconcile("compute_policy", async () => {
  const allocation = await readComputeAllocation();
  if (!allocation) return { phase: "unarmed" };
  const target = `compute/v1/projects/${allocation.project}/zones/${allocation.zone}/instances/${allocation.instance}`;
  return reconcileComputeAllocation(allocation, {
    now: () => Math.floor(Date.now() / 1000),
    readState: () => readComputeState(allocation.allocationId),
    saveState: saveComputeState,
    observe: async () => {
      rpc ??= await readSecret("fleet-base-sepolia-rpc-url");
      return observeComputeApproval(allocation, rpc);
    },
    readVm: async () => await (await googleRequest("compute", target)).json() as { id: string; status: string },
    stopVm: async () => {
      const operation = await (await googleRequest("compute", `${target}/stop?noGracefulShutdown=true`, { method: "POST" })).json() as { name: string };
      return { operationId: operation.name };
    },
  });
}, "Compute governance could not finish verification. No authority was extended.");
