import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ACTIVE, runPath, type DemoRun, type DemoStatus } from "./control.js";
import { readObject, writeObject } from "./google.js";
import { readSimulationRequest, readSimulationWork, simulationPath } from "./simulation.js";
import { isComputeRunBlocked } from "./compute-store.js";

const delay = () => new Promise(resolve => setTimeout(resolve, 5000));
let stopping = false;
let activeChild: ChildProcess | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  stopping = true;
  if (activeChild?.pid) { try { process.kill(-activeChild.pid, "SIGTERM"); } catch { /* Child already exited. */ } }
});
while (!stopping && process.env.FLEET_WORKER_ENABLED === "1") {
  try {
    const simulation = await readSimulationRequest();
    if (simulation) {
      const state = await readObject<{ terminal?: boolean }>(simulationPath(simulation.runId));
      if (!state?.terminal && !await isComputeRunBlocked(simulation.runId) && await readSimulationWork(simulation.runId)) {
        const child = spawn("flock", ["--nonblock", "--conflict-exit-code", "75", "/srv/fleet/state/lifecycle.lock", process.execPath, "apps/runner/dist/cloud/simulation-worker.js", simulation.runId], { cwd: process.cwd(), stdio: "inherit", env: process.env, detached: true });
        activeChild = child;
        try {
          const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
          if (code !== 75) {
            const final = await readObject<{ terminal?: boolean }>(simulationPath(simulation.runId));
            if (!final?.terminal) await writeObject(simulationPath(simulation.runId), { ...final, runId: simulation.runId,
              phase: "failed", terminal: true, updatedAt: new Date().toISOString(),
              message: `Worker exited (${code ?? "signal"}). Recorded work is preserved. This run cannot restart.` });
          }
        }
        finally { activeChild = undefined; }
      }
      // A reserved simulation owns the worker even after its process exits.
      await delay(); continue;
    }
    const active = await readObject<{ runId: string }>(ACTIVE);
    if (!active) { await delay(); continue; }
    if (await isComputeRunBlocked(active.runId)) { await delay(); continue; }
    const status = await readObject<DemoStatus>(runPath(active.runId, "status.json"));
    if (status?.terminal) { await delay(); continue; }
    const run = await readObject<DemoRun>(runPath(active.runId, "request.json"));
    if (!run) throw new Error("The active experiment has no request.");
    const stateDir = "/srv/fleet/state";
    mkdirSync(stateDir, { recursive: true });
    const marker = path.join(stateDir, "active-experiment.json");
    writeFileSync(marker, JSON.stringify({ runId: run.runId, startedAt: new Date().toISOString() }), { mode: 0o600 });
    try {
      const child = spawn("flock", ["--nonblock", "--conflict-exit-code", "75", "/srv/fleet/state/lifecycle.lock", process.execPath, "apps/runner/dist/cloud/run.js", run.runId], { cwd: process.cwd(), stdio: "inherit", env: process.env, detached: true });
      activeChild = child;
      const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
      if (code === 75) { await delay(); continue; }
      const final = await readObject<DemoStatus>(runPath(run.runId, "status.json"));
      if (!final?.terminal) await writeObject(runPath(run.runId, "status.json"), { ...final, runId: run.runId, phase: "failed", terminal: true, updatedAt: new Date().toISOString(), message: `Worker exited (${code ?? "signal"}). Inspect this run before retrying.`, });
    } finally { activeChild = undefined; rmSync(marker, { force: true }); }
  } catch { console.error("Experiment queue check failed. Private provider diagnostics withheld."); }
  await delay();
}
