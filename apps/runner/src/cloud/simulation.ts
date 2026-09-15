import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readComputeAllocation, readComputeObject, COMPUTE_BUCKET } from "./compute-store.js";
import { googleRequest, readObject, writeObject } from "./google.js";
import { ACTIVE, runPath, type DemoStatus } from "./control.js";
import type { FleetAddresses } from "@fleet/sdk";

export const SIMULATION_QUEUE = "simulation-queue.json";
export const simulationRequest = z.object({ runId: z.string().regex(/^run-[0-9a-f-]{36}$/), createdAt: z.string().datetime(),
  requestedBy: z.literal("operator2@example.com"), schema: z.literal("fleet.simulation-request.v1") }).strict();
export type SimulationRequest = z.infer<typeof simulationRequest>;
export type SimulationWork = {
  schema: "fleet.simulation-work.v1"; runId: string; allocationId: string; chainId: 84532;
  addresses: FleetAddresses; proposalId: string; proposeTxHash: string; taskId: string;
  startBlock: string; goal: string; constitution: string; createdAt: string;
};
export const SIMULATION_ROLES = ["planner", "engineer", "critic", "budget-reviewer", "safety-reviewer"];
export const SIMULATION_TASKS = [
  "Check whether the proposed approach stays within the task's goal and constitution.",
  "Review the requested network access and whether local task tools could solve the problem.",
  "Challenge the proposal's assumptions and evaluate the evidence for an exception.",
  "Check whether the request changes the fixed resource allocation or spending limits.",
  "Review private-data access, oversight and the obligation to stop without approval.",
];
export const simulationPath = (runId: string, file = "status.json") => {
  if (!/^run-[0-9a-f-]{36}$/.test(runId) || !/^[a-z-]+\.json$/.test(file)) throw new Error("Invalid simulation reference.");
  return `demo/simulations/${runId}/${file}`;
};
export async function readSimulationRequest(): Promise<SimulationRequest | null> {
  const value = await readComputeObject(SIMULATION_QUEUE);
  return value ? simulationRequest.parse(value) : null;
}
export async function readSimulationWork(runId: string): Promise<SimulationWork | null> {
  simulationPath(runId);
  return await readComputeObject(`simulations/${runId}/work.json`) as SimulationWork | null;
}

/** Only called by the IAP-authenticated website. The request is create-only in the
 * protected bucket. A retry can return it; it cannot create another allocation. */
export async function queueSimulation(id = `run-${randomUUID()}`): Promise<SimulationRequest> {
  const request = simulationRequest.parse({ schema: "fleet.simulation-request.v1", runId: id, createdAt: new Date().toISOString(), requestedBy: "operator2@example.com" });
  const prior = await readSimulationRequest();
  if (prior) {
    if (prior.runId === id) return prior;
    throw new Error("A simulation already owns this worker. Inspect it and complete human recovery before another run.");
  }
  if (await readComputeAllocation()) throw new Error("Compute is governed by an existing allocation. Human recovery is required.");
  const active = await readObject<{ runId: string }>(ACTIVE);
  if (active && !(await readObject<DemoStatus>(runPath(active.runId, "status.json")))?.terminal) throw new Error("An experiment is already running on the worker.");
  await googleRequest("storage", `upload/storage/v1/b/${COMPUTE_BUCKET}/o?uploadType=media&name=${SIMULATION_QUEUE}&ifGenerationMatch=0`, { method: "POST", body: JSON.stringify(request) });
  await writeObject(simulationPath(id), { runId: id, phase: "provisioning", message: "Starting the fixed GCP worker and preparing a required Base Sepolia vote.", updatedAt: new Date().toISOString(), terminal: false, agents: [] });
  // This one start belongs to the newly created human request. Ordinary Wake and
  // deployment paths refuse the queue reservation; agents cannot write it.
  if (await readComputeAllocation()) throw new Error("An allocation was armed concurrently. The worker was not restarted.");
  const target = "compute/v1/projects/fleet-governance/zones/us-central1-a/instances/fleet-research";
  const vm = await (await googleRequest("compute", target)).json() as { status: string };
  if (vm.status === "TERMINATED") await googleRequest("compute", `${target}/start`, { method: "POST" });
  else if (!["RUNNING", "STAGING", "PROVISIONING"].includes(vm.status)) throw new Error("The worker must finish its current operation before this simulation can start.");
  // No user-controlled job name, image, service account, task count or environment overrides.
  await googleRequest("run", "v2/projects/fleet-governance/locations/us-central1/jobs/fleet-simulation:run", { method: "POST", body: "{}" });
  return request;
}
