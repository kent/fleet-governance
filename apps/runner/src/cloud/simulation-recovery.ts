import { z } from "zod";
import { readComputeAllocation, readComputeObject, isComputeRunBlocked, COMPUTE_BUCKET } from "./compute-store.js";
import { COMPUTE_TARGET, writeControlObject, type NativeVm } from "./compute-admin.js";
import { googleRequest, writeObject } from "./google.js";
import { readSimulationRequest, simulationPath } from "./simulation.js";

/** Explicit human CI recovery for a preparation job that never armed compute.
 * Never callable by the launcher, runtime or model. */
export async function checkPreparationRecovery(runId: string): Promise<void> {
  z.string().regex(/^run-[0-9a-f-]{36}$/).parse(runId);
  const request = await readSimulationRequest();
  if (request?.runId !== runId || await readComputeAllocation() || await readComputeObject(`simulations/${runId}/work.json`)) throw new Error("Only an unarmed, exact preparation request can be recovered here.");
  let token = "";
  do {
    const page = await (await googleRequest("run", `v2/projects/fleet-governance/locations/us-central1/jobs/fleet-simulation/executions?pageSize=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`)).json() as { executions?: { completionTime?: string }[]; nextPageToken?: string };
    if (page.executions?.some(execution => !execution.completionTime)) throw new Error("Wait for the preparation execution to finish before recovery.");
    token = page.nextPageToken ?? "";
  } while (token);
}
export async function releasePreparation(runId: string): Promise<void> {
  await checkPreparationRecovery(runId);
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as NativeVm;
  if (vm.status !== "TERMINATED") throw new Error("The VM must be verified off before releasing a preparation request.");
  if (!await isComputeRunBlocked(runId)) await writeControlObject(`blocked-runs/${runId}.json`, { runId, reason: "preparation_recovered", recoveredAt: new Date().toISOString(), workflowRun: process.env.GITHUB_RUN_ID });
  await writeObject(simulationPath(runId), { runId, terminal: true, phase: "recovered", updatedAt: new Date().toISOString(), message: "A human retired this incomplete preparation. This run cannot be resumed." });
  const object = `storage/v1/b/${COMPUTE_BUCKET}/o/simulation-queue.json`;
  const meta = await (await googleRequest("storage", object)).json() as { generation: string };
  if (!/^[0-9]+$/.test(meta.generation)) throw new Error("Invalid queue generation.");
  const request = await (await googleRequest("storage", `${object}?alt=media&generation=${meta.generation}`)).json() as { runId: string };
  if (request.runId !== runId || await readComputeAllocation()) throw new Error("Authority changed during preparation recovery.");
  await googleRequest("storage", `${object}?ifGenerationMatch=${meta.generation}`, { method: "DELETE" });
}
