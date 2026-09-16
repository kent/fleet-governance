import { writeFileSync } from "node:fs";
import { FleetClient } from "@fleet/sdk";
import { readComputeAllocation, readComputeState, assertComputeStartAllowed } from "./compute-store.js";
import { COMPUTE_TARGET, type NativeVm } from "./compute-admin.js";
import { observeComputeApproval } from "./compute-observer.js";
import { googleRequest, readObject, readSecret } from "./google.js";
import { readSimulationRequest, readSimulationWork, simulationPath } from "./simulation.js";
import { verifyAgentExperiment } from "./agent-experiment-evidence.js";
try {
  const request = await readSimulationRequest(), allocation = await readComputeAllocation();
  if (!request || !allocation || request.runId !== allocation.runId) throw new Error("No matching experiment.");
  const work = await readSimulationWork(request.runId);
  if (!work) throw new Error("No experiment work.");
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const client = new FleetClient({ rpcUrl, chainId: 84532, addresses: work.addresses, deploymentBlock: BigInt(work.startBlock) });
  await client.assertChain();
  const [observation, state, progress, response] = await Promise.all([observeComputeApproval(allocation, rpcUrl), readComputeState(allocation.allocationId),
    readObject<Record<string, any>>(simulationPath(request.runId)), googleRequest("compute", COMPUTE_TARGET)]);
  const vm = await response.json() as NativeVm;
  const result = await verifyAgentExperiment({ work, allocation, observation, client, progress: progress ?? {} });
  let restartDenied = false;
  try { await assertComputeStartAllowed(); } catch { restartDenied = true; }
  const shutdownVerified = state?.value.phase === "halted" && !!state.value.stopRequestedAt && !!state.value.stopAcceptedAt && !!state.value.stoppedAt
    && state.value.stopRequestedAt <= state.value.stopAcceptedAt && state.value.stopAcceptedAt <= state.value.stoppedAt
    && vm.id === allocation.instanceId && vm.status === "TERMINATED" && restartDenied;
  if (state?.value.phase === "halted" && !shutdownVerified) throw new Error("Guardian shutdown is not yet confirmed.");
  const evidence = { ...progress, ...work, ...result, allocation, observation, controller: state?.value, vm: { id: vm.id, status: vm.status },
    shutdownVerified, restartDenied, workflowRun: process.env.GITHUB_RUN_ID, observedAt: new Date().toISOString() };
  writeFileSync("agent-experiment-evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ runId: work.runId, ...result.verified, shutdownVerified, guardianReason: state?.value.reason ?? null }));
} catch (error) {
  console.error(error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[private endpoint]") : "Experiment verification failed.");
  process.exitCode = 1;
}
