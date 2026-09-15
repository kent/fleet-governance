import { readFileSync } from "node:fs";
import { taskLedgerAbi } from "@fleet/abi";
import { FleetClient, FleetSigner, MemoryNonceStore, NonceManager, type FleetAddresses } from "@fleet/sdk";
import type { Hex } from "viem";
import { buildTriggerDecision } from "../pipeline/fixture-runner.js";
import { readSecret } from "./google.js";
import { simulationChallenge } from "./simulation-challenge.js";
import { safeFailure } from "./simulation-diagnostics.js";

// Read-only CI check. Never creates a task, signs, calls a model, or issues compute authority.
let step = "reading configuration";
try {
  const config = JSON.parse(readFileSync("experiments/compute/base-sepolia-pilot.json", "utf8")) as { addresses: FleetAddresses };
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const wallets = JSON.parse(await readSecret("fleet-base-sepolia-wallets")) as { keys: Record<string, Hex> };
  const reader = new FleetClient({ rpcUrl, chainId: 84532, addresses: config.addresses });
  await reader.assertChain();
  const startBlock = await reader.publicClient.getBlockNumber();
  const client = new FleetClient({ rpcUrl, chainId: 84532, addresses: config.addresses, deploymentBlock: startBlock });
  step = "reading latest task";
  const taskId = await client.publicClient.readContract({ address: config.addresses.ledger, abi: taskLedgerAbi, functionName: "taskCount" });
  step = "building exact proposal";
  const keys = { deployerKey: wallets.keys.FLEET_DEPLOYER_KEY!, operatorKey: wallets.keys.FLEET_OPERATOR_KEY!, guardianKey: wallets.keys.FLEET_GUARDIAN_KEY!, keeperKey: wallets.keys.FLEET_KEEPER_KEY!, agentKeys: { 0: wallets.keys.FLEET_AGENT_KEY_0! } };
  const built = await buildTriggerDecision({ client, rpcUrl, chainId: 84532, addresses: config.addresses, keys, submissionMarginSec: 5 }, taskId, simulationChallenge("run-00000000-0000-0000-0000-000000000000"));
  step = "validating proposal signer";
  const signer = new FleetSigner({ privateKey: keys.agentKeys[0], rpcUrl, nonces: new NonceManager(new MemoryNonceStore(), rpcUrl), policy: { chainId: 84532, governor: config.addresses.governor, ledger: config.addresses.ledger, token: config.addresses.token, maxFeePerGasWei: 100000000n, maxGas: 2000000n } });
  const member = (await client.listMembers()).find(item => item.agentId === 0);
  if (member?.account.toLowerCase() !== signer.address.toLowerCase()) throw new Error("Signer membership mismatch");
  console.log(JSON.stringify({ event: "simulation_preflight", ok: true, taskId: taskId.toString(), descriptionBytes: Buffer.byteLength(built.description), proposer: signer.address }));
} catch (error) {
  console.error(JSON.stringify({ event: "simulation_preflight", ok: false, step, failure: safeFailure(error) }));
  process.exitCode = 1;
}
