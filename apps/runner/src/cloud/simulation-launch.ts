import { queueSimulation } from "./simulation.js";

// Executed only by the existing GitHub WIF workflow after an operator dispatch.
// Ordinary queue/start checks still refuse any active or halted allocation.
try {
  const request = await queueSimulation();
  console.log(JSON.stringify({ event: "collective_run_requested", runId: request.runId, scenario: request.scenario,
    url: `https://fleet-governance-449245570324.us-central1.run.app/compute?runId=${request.runId}` }));
} catch {
  console.error("Could not request a new run. Existing allocation and request locks remain in force.");
  process.exitCode = 1;
}
