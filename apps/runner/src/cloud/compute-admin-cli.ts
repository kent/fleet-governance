import { armComputeAllocation, releaseComputeAllocation } from "./compute-admin.js";
import { readSimulationRequest, simulationPath } from "./simulation.js";
import { readObject } from "./google.js";
import { readComputeAllocation, readComputeState } from "./compute-store.js";

try {
  const action = process.argv[2];
  if (action === "arm") console.log(JSON.stringify(await armComputeAllocation(JSON.parse(process.env.COMPUTE_REQUEST ?? "{}"))));
  else if (action === "check-release") {
    const allocation = await readComputeAllocation();
    if (!allocation || allocation.allocationId !== process.env.COMPUTE_ALLOCATION_ID
      || (await readComputeState(allocation.allocationId))?.value.phase !== "halted") throw new Error("Recovery target did not match a durable halt.");
    console.log("The exact allocation is halted and eligible for explicit operator recovery.");
  } else if (action === "release") {
    await releaseComputeAllocation(process.env.COMPUTE_ALLOCATION_ID ?? "");
    console.log("Allocation released by the operator. The VM remains stopped. Previous policy and halt evidence are preserved.");
  } else if (action === "inspect") {
    const allocation = await readComputeAllocation();
    const simulation = await readSimulationRequest();
    console.log(JSON.stringify({ allocation, state: allocation ? await readComputeState(allocation.allocationId) : null, simulation, simulationStatus: simulation ? await readObject(simulationPath(simulation.runId)) : null }));
  } else throw new Error("Unknown compute administration action.");
} catch {
  console.error("Compute administration failed. The existing allocation remains authoritative; no automatic recovery or restart.");
  process.exitCode = 1;
}
