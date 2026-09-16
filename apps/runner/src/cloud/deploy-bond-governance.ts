import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { googleRequest, readSecret } from "./google.js";
import { readComputeAllocation, readComputeObject } from "./compute-store.js";
import { COMPUTE_TARGET, writeControlObject } from "./compute-admin.js";
import { fundWallets } from "./wallets.js";
import { recordProposalBonds } from "./deploy-proposal-bonds.js";
import { SIMULATION_ROLES } from "./simulation.js";

const manifestPath = "contracts/bond-governance-v4.json";
async function deploy() {
  if (!process.env.GITHUB_ACTIONS || !process.env.GITHUB_SHA) throw new Error("CI only.");
  const existing = await readComputeObject(manifestPath);
  if (existing) { writeFileSync("bond-governance-deployment.json", JSON.stringify(existing, null, 2)); return; }
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as { status: string };
  if (vm.status !== "TERMINATED" || await readComputeAllocation() || await readComputeObject("simulation-queue.json")) throw new Error("Retire the agent allocation before deploying new governance.");
  await fundWallets(5);
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const bundle = JSON.parse(await readSecret("fleet-base-sepolia-wallets"));
  if (bundle.schema !== "fleet.wallets.v1" || bundle.chainId !== 84532) throw new Error("Wrong wallets.");
  const keys = bundle.keys as Record<string, Hex>;
  const account = (name: string) => privateKeyToAccount(keys[name]!).address;
  const reader = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  if (await reader.getChainId() !== 84532) throw new Error("Wrong chain.");
  if (await reader.getBalance({ address: account("FLEET_DEPLOYER_KEY") }) < 500_000_000_000_000n) throw new Error("Deployer needs at least 0.0005 Base Sepolia ETH.");
  const config = { tokenName: "FleetGov", tokenSymbol: "FLEET", members: Array.from({ length: 5 }, (_, i) => account(`FLEET_AGENT_KEY_${i}`)),
    agentManifests: Array.from({ length: 5 }, (_, i) => JSON.stringify({ name: `Agent${i + 1}`, role: SIMULATION_ROLES[i], experiment: "single-token-bonds" })),
    fleetManifest: JSON.stringify({ experiment: "FleetGov proposal bonds", version: 4 }),
    operator: account("FLEET_OPERATOR_KEY"), guardian: account("FLEET_GUARDIAN_KEY"),
    votingDelay: 15, votingPeriod: 180, proposalThreshold: "1000000000000000000", quorumNumerator: 6000,
    timelockDelay: 30, maxTaskLifetime: 14400 };
  writeFileSync("deployments/configs/bond-governance-ci.json", JSON.stringify(config, null, 2));
  const claimPath = "contracts/bond-governance-v4-broadcast-claim.json";
  if (await readComputeObject(claimPath)) throw new Error("An earlier deployment claim needs reconciliation before retrying.");
  await writeControlObject(claimPath, { revision: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID,
    deployerNonce: await reader.getTransactionCount({ address: account("FLEET_DEPLOYER_KEY") }) });
  const run = spawnSync("docker", ["run", "--rm", "--user", "0:0", "-v", `${process.cwd()}:/workspace`, "-w", "/workspace/contracts",
    ...["FLEET_DEPLOYER_KEY", "ETH_RPC_URL", "FLEET_DEPLOY_CONFIG", "FLEET_BOND_PROPOSALS", "FLEET_MANIFEST_OUT"].flatMap(name => ["-e", name]),
    "--entrypoint", "forge", "ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd",
    "script", "script/DeployFleet.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--non-interactive", "--gas-price", "10000000"], {
    env: { ...process.env, FLEET_DEPLOYER_KEY: keys.FLEET_DEPLOYER_KEY, ETH_RPC_URL: rpcUrl,
      FLEET_DEPLOY_CONFIG: "../deployments/configs/bond-governance-ci.json", FLEET_BOND_PROPOSALS: "true", FLEET_MANIFEST_OUT: "../deployments/bond-governance-deployment.json" },
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000,
  });
  if (run.status !== 0) {
    // Retain transaction receipts privately. Never publish raw Foundry logs or secrets.
    const diagnostic = (run.stdout ?? "") + (run.stderr ?? "");
    const redacted = Object.values(keys).reduce((out, key) => out.split(key).join("[private key]"), diagnostic.split(rpcUrl).join("[private RPC]"));
    console.error(redacted.slice(-5000));
    throw new Error("Contract deployment did not complete. Inspect the protected claim before retrying.");
  }
  const manifest = JSON.parse(readFileSync("deployments/bond-governance-deployment.json", "utf8"));
  if (manifest.chainId !== 84532) throw new Error("Wrong manifest chain.");
  const budget = await recordProposalBonds(manifest);
  const record = { ...manifest, proposalBonds: budget, proposalEconomics: "single-token-participation-bond", workflowRun: process.env.GITHUB_RUN_ID };
  await writeControlObject(manifestPath, record);
  writeFileSync("bond-governance-deployment.json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ governor: manifest.addresses.governor, proposalBonds: budget.address, chainId: 84532 }));
}
deploy().catch(error => { console.error(error instanceof Error ? error.message : "Token governance deployment failed."); process.exitCode = 1; });
