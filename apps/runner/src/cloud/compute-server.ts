import { createServer } from "node:http";
import { reconcileComputeAllocation } from "./compute-controller.js";
import { observeComputeApproval } from "./compute-observer.js";
import { readComputeAllocation, readComputeState, saveComputeState } from "./compute-store.js";
import { googleRequest, readSecret } from "./google.js";

let rpc: string | undefined;
let running = false;
/** Invoked by Cloud Scheduler using its own Cloud Run invoker identity. There is
 * no worker-controlled target, allocation update, resource extension or start endpoint. */
createServer(async (request, response) => {
  const reply = (status: number, data: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(data));
  };
  if (request.url === "/healthz" && request.method === "GET") { reply(200, { ok: true }); return; }
  if (request.url !== "/reconcile" || request.method !== "POST") { reply(404, { error: "Unknown operation." }); return; }
  if (running) { reply(409, { error: "Reconciliation is already in progress." }); return; }
  running = true;
  try {
    const allocation = await readComputeAllocation();
    if (!allocation) { reply(200, { phase: "unarmed" }); return; }
    const target = `compute/v1/projects/${allocation.project}/zones/${allocation.zone}/instances/${allocation.instance}`;
    const state = await reconcileComputeAllocation(allocation, {
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
    console.log(JSON.stringify({ event: "compute_policy_observed", ...state }));
    reply(200, state);
  } catch {
    // A rejected or lost API call is not a stopped VM. Scheduler retries; the VM's
    // independently configured termination time is the fallback if this service is down.
    console.error("Compute governance reconciliation failed. No authority was extended.");
    reply(503, { error: "Compute governance could not finish verification. Retry required." });
  } finally { running = false; }
}).listen(Number(process.env.PORT ?? "8080"), "0.0.0.0", () => console.log("Fleet compute controller ready."));
