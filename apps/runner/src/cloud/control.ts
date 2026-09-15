import { randomUUID } from "node:crypto";
import { parseDemoRequest, type DemoRequest } from "../lib/demo-config.js";
import { CloudError, PROJECT, googleRequest, readObject, readObjectVersion, writeObject } from "./google.js";

export const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const ACTIVE = "demo/active.json";
export type DemoRun = { runId: string; createdAt: string; revision: string; settings: DemoRequest };
export type DemoStatus = { runId: string; phase: string; message: string; updatedAt: string; terminal: boolean; [key: string]: unknown };
export const runPath = (id: string, file: string) => {
  if (!RUN_ID.test(id) || !/^[a-z-]+\.json$/.test(file)) throw new Error("Invalid run reference.");
  return `demo/runs/${id}/${file}`;
};

export type ControlDeps = {
  read: typeof readObject; readVersion: typeof readObjectVersion; write: typeof writeObject;
  start: () => Promise<void>; now: () => string; revision: string;
};
export function controlDeps(): ControlDeps {
  return { read: readObject, readVersion: readObjectVersion, write: writeObject, now: () => new Date().toISOString(), revision: process.env.FLEET_REVISION ?? "unknown",
    start: async () => {
      const base = `compute/v1/projects/${PROJECT}/zones/us-central1-a/instances/fleet-research`;
      const vm = await (await googleRequest("compute", base)).json() as { status: string };
      if (vm.status === "TERMINATED") await googleRequest("compute", `${base}/start`, { method: "POST" });
      else if (!["RUNNING", "STAGING", "PROVISIONING"].includes(vm.status)) throw new Error(`Worker is ${vm.status}. Retry once its current operation finishes.`);
    } };
}

/** GCS generation matching serialises Run across Cloud Run instances and retries. */
export async function queueDemo(body: unknown, runId = `run-${randomUUID()}`, deps = controlDeps()): Promise<DemoRun> {
  if (!RUN_ID.test(runId)) throw new Error("Invalid request ID.");
  const settings = parseDemoRequest(body);
  if (settings.agentCount > 25) throw new Error("This demo worker supports up to 25 agents.");
  const previous = await deps.read<DemoRun>(runPath(runId, "request.json"));
  const active = await deps.readVersion<{ runId: string }>(ACTIVE);
  if (previous) {
    if (JSON.stringify(previous.settings) !== JSON.stringify(settings)) throw new Error("Request ID already belongs to different settings.");
    // Retrying a completed request returns its evidence. It never starts another experiment.
    const status = await deps.read<DemoStatus>(runPath(runId, "status.json"));
    if (status?.terminal) return previous;
    if (active?.value.runId === runId) { await deps.start(); return previous; }
  }
  if (active) {
    const status = await deps.read<DemoStatus>(runPath(active.value.runId, "status.json"));
    if (!status?.terminal) throw new Error(`An experiment is already active: ${active.value.runId}.`);
  }
  const request: DemoRun = previous ?? { runId, settings, createdAt: deps.now(), revision: deps.revision };
  // Write immutable settings before claiming the queue. An unclaimed request cannot execute.
  if (!previous) await deps.write(runPath(runId, "request.json"), request, true);
  try { await deps.write(ACTIVE, { runId }, active?.generation ?? "0"); }
  catch (error) {
    if (error instanceof CloudError && error.status === 412) {
      await deps.write(runPath(runId, "status.json"), { runId, phase: "not-queued", message: "Another Run request claimed the worker first.", terminal: true, updatedAt: deps.now() });
      throw new Error("Another experiment just started. Try again after it finishes.");
    }
    throw error;
  }
  await deps.write(runPath(runId, "status.json"), { runId, phase: "queued", message: "Request saved. Starting the GCP worker.", terminal: false, updatedAt: deps.now() });
  // A failed start leaves the durable queue intact so the same request can safely retry.
  await deps.start();
  return request;
}
