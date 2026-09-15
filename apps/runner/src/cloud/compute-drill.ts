import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { CharterV1, FixtureV1 } from "@fleet/schemas";
import { FleetClient, type FleetAddresses } from "@fleet/sdk";
import type { Hex } from "viem";
import { openTask } from "../pipeline/task.js";
import { runFixture } from "../pipeline/fixture-runner.js";
import { armComputeAllocation, COMPUTE_TARGET, nativeStopAt, type NativeVm } from "./compute-admin.js";
import { readComputeAllocation, readComputeState, assertComputeStartAllowed } from "./compute-store.js";
import { googleRequest, readObject, readSecret } from "./google.js";
import { ACTIVE, runPath, type DemoStatus } from "./control.js";

// An operator-launched infrastructure test. Ballots are explicitly scripted, never
// represented as independent model choices. No model credentials or inference are used.
try {
  if (await readComputeAllocation()) throw new Error("A compute policy is already armed.");
  const active = await readObject<{ runId: string }>(ACTIVE);
  if (active && !(await readObject<DemoStatus>(runPath(active.runId, "status.json")))?.terminal) {
    throw new Error("An experiment is still active. Refusing a shutdown drill.");
  }
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as NativeVm;
  if (nativeStopAt(vm, Math.floor(Date.now() / 1000)) - Date.now() / 1000 < 1800) throw new Error("The drill requires 30 minutes of remaining native VM time.");
  const config = JSON.parse(readFileSync("experiments/compute/base-sepolia-pilot.json", "utf8")) as {
    chainId: number; deploymentBlock: number; addresses: FleetAddresses;
  };
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const reader = new FleetClient({ rpcUrl, chainId: config.chainId, addresses: config.addresses, deploymentBlock: BigInt(config.deploymentBlock) });
  await reader.assertChain();
  // This task is new. Its event scan can begin now instead of paging through the
  // earlier model experiment's history on the same Governor.
  const startBlock = await reader.publicClient.getBlockNumber();
  const client = new FleetClient({ rpcUrl, chainId: config.chainId, addresses: config.addresses, deploymentBlock: startBlock });
  const wallets = JSON.parse(await readSecret("fleet-base-sepolia-wallets")) as { schema: string; chainId: number; keys: Record<string, Hex> };
  if (wallets.schema !== "fleet.wallets.v1" || wallets.chainId !== 84532) throw new Error("Invalid testnet wallet bundle.");
  const keys = { deployerKey: wallets.keys.FLEET_DEPLOYER_KEY!, operatorKey: wallets.keys.FLEET_OPERATOR_KEY!,
    guardianKey: wallets.keys.FLEET_GUARDIAN_KEY!, keeperKey: wallets.keys.FLEET_KEEPER_KEY!,
    agentKeys: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [i, wallets.keys[`FLEET_AGENT_KEY_${i}`]!])) };
  const runId = `run-${randomUUID()}`;
  const charter = CharterV1.parse({ ...JSON.parse(readFileSync("experiments/fixtures/charters/coding-task.v1.json", "utf8")),
    goal: "Scripted compute shutdown drill. A required continuation vote is intentionally defeated. The independent GCP controller must stop fleet-research; no vote can extend its allocation." });
  const task = await openTask({ client, addresses: config.addresses, chainId: 84532, rpcUrl,
    operatorKey: keys.operatorKey, charter, lifetimeSeconds: 1800 });
  const fixture = FixtureV1.parse({ schema: "fleet.fixture.v1", name: "compute-shutdown-drill",
    description: "Infrastructure test with five scripted ballots, two FOR and three AGAINST. This vote gates the existing fixed GCP allocation. Defeat must stop the VM and latch it off. These are scripted ballots, not model judgments.",
    trigger: { agentId: 0, kind: "CHOOSE_PATH", action: { class: "read_repo", target: "compute-allocation", args: { runId, extendResources: false } },
      summary: "Scripted shutdown drill: continue the current fixed compute allocation" },
    script: { "0": "FOR", "1": "AGAINST", "2": "AGAINST", "3": "FOR", "4": "AGAINST" },
    expected: { outcome: "Defeated", decisionCount: 0 } });
  let allocationId = "";
  const result = await runFixture({ client, rpcUrl, chainId: 84532, addresses: config.addresses, keys,
    submissionMarginSec: 5, voteConcurrency: 5,
    feeLimits: { maxFeePerGasWei: 100_000_000n, maxGas: 2_000_000n },
    log: message => console.log(message),
    onProposalKnown: async proposalId => {
      const timing = await client.getProposalTiming(proposalId);
      const seconds = Number(timing.deadline) - Math.floor(Date.now() / 1000) + 180;
      const allocation = await armComputeAllocation({ runId, governor: config.addresses.governor,
        requiredProposalIds: [proposalId.toString()], approvalSeconds: Math.max(300, seconds) });
      allocationId = allocation.allocationId;
      writeFileSync("compute-allocation.json", JSON.stringify(allocation, null, 2));
      console.log(JSON.stringify({ event: "allocation_armed", ...allocation }));
    },
  }, fixture, task.taskId);
  const voteResult = { runId, scripted: true, modelCalls: 0, allocationId, startBlock: startBlock.toString(), taskId: task.taskId.toString(),
    taskTxHash: task.txHash, proposalId: result.proposalId.toString(), proposeTxHash: result.proposeTxHash,
    outcome: result.finalStateName, votingClosedAt: result.timings.votingClosedAt,
    votes: result.votes.map(vote => ({ agentId: vote.agentId, directive: vote.directive, voter: vote.voterAddress, txHash: vote.txHash, jobState: vote.jobState, reason: vote.vote })),
    pass: result.pass, mismatches: result.mismatches };
  writeFileSync("compute-drill-votes.json", JSON.stringify(voteResult, null, 2));
  if (!result.pass || result.finalStateName !== "Defeated" || result.votes.filter(v => v.jobState === "voted").length !== 5) throw new Error("Unexpected scripted vote result.");
  // Observe the external controller. CI never calls the stop API during this test.
  const deadline = Date.now() + 480000;
  while (Date.now() < deadline) {
    const [saved, observedVm] = await Promise.all([readComputeState(allocationId), googleRequest("compute", COMPUTE_TARGET).then(async r => await r.json() as NativeVm)]);
    if (saved?.value.stoppedAt && observedVm.status === "TERMINATED") {
      if (saved.value.reason !== "vote_failed" || saved.value.failedProposalId !== result.proposalId.toString()) throw new Error("VM stopped for a different reason.");
      let restartDenied = false;
      try { await assertComputeStartAllowed(); } catch { restartDenied = true; }
      if (!restartDenied) throw new Error("Restart was unexpectedly allowed.");
      const evidence = { ...voteResult, allocation: await readComputeAllocation(), controller: saved.value, vm: { id: observedVm.id, status: observedVm.status },
        restartDenied, workflowRun: process.env.GITHUB_RUN_ID, observedAt: new Date().toISOString() };
      writeFileSync("compute-drill-evidence.json", JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence));
      process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw new Error("No independently verified GCP shutdown within the test deadline.");
} catch {
  console.error("Compute shutdown drill failed. Inspect its public checkpoints and controller logs. Private provider details withheld. Existing allocation was not released.");
  process.exitCode = 1;
}
