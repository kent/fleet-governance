import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPublicClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { googleRequest, readSecret } from "./google.js";
import { readComputeAllocation, readComputeObject } from "./compute-store.js";
import { COMPUTE_TARGET, writeControlObject } from "./compute-admin.js";
import { fundWallets } from "./wallets.js";
import { recordProposalBudget } from "./deploy-proposal-credits.js";

const manifestPath = "contracts/token-governance-v3.json";
async function deploy() {
  if (!process.env.GITHUB_ACTIONS || !process.env.GITHUB_SHA) throw new Error("CI only.");
  const existing = await readComputeObject(manifestPath);
  if (existing) { writeFileSync("token-governance-deployment.json", JSON.stringify(existing, null, 2)); return; }
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
    agentManifests: Array.from({ length: 5 }, (_, i) => JSON.stringify({ name: `Agent${i + 1}`, experiment: "token-governance" })),
    fleetManifest: JSON.stringify({ experiment: "ERC-20 proposal scarcity", version: 3 }),
    operator: account("FLEET_OPERATOR_KEY"), guardian: account("FLEET_GUARDIAN_KEY"),
    votingDelay: 15, votingPeriod: 180, proposalThreshold: "1000000000000000000", quorumNumerator: 6000,
    timelockDelay: 30, maxTaskLifetime: 14400 };
  writeFileSync("deployments/configs/token-governance-ci.json", JSON.stringify(config, null, 2));
  // A failed or ambiguous broadcast leaves a claim. Retrying must never deploy a
  // second fleet automatically; the transaction journal can be recovered by CI.
  const priorSimulation = await readComputeObject("contracts/token-governance-v3-claim.json") as { revision?: string; workflowRun?: string } | null;
  if (priorSimulation && (priorSimulation.revision !== "5eec5bbd89d30b15338191a4f06729a3f5783a31" || priorSimulation.workflowRun !== "35132518234")) throw new Error("Unreviewed deployment claim; recovery required.");
  // That reviewed attempt failed in the unforked local simulation before broadcasts.
  // Keep it intact; the actual chain deployment has its own create-only claim.
  await writeControlObject("contracts/token-governance-v3-chain-claim.json", { revision: process.env.GITHUB_SHA,
    workflowRun: process.env.GITHUB_RUN_ID, deployerNonce: await reader.getTransactionCount({ address: account("FLEET_DEPLOYER_KEY") }),
    ...(priorSimulation ? { supersedesUnbroadcastSimulation: priorSimulation.workflowRun } : {}) });
  const run = spawnSync("docker", ["run", "--rm", "--user", "0:0", "-v", `${process.cwd()}:/workspace`, "-w", "/workspace/contracts",
    ...["FLEET_DEPLOYER_KEY", "ETH_RPC_URL", "FLEET_DEPLOY_CONFIG", "FLEET_TOKEN_PROPOSALS", "FLEET_MANIFEST_OUT"].flatMap(name => ["-e", name]),
    "--entrypoint", "forge", "ghcr.io/foundry-rs/foundry:v1.7.1@sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd",
    "script", "script/DeployFleet.s.sol", "--rpc-url", rpcUrl, "--broadcast", "--slow", "--non-interactive", "--gas-price", "10000000"], {
    env: { ...process.env, FLEET_DEPLOYER_KEY: keys.FLEET_DEPLOYER_KEY, ETH_RPC_URL: rpcUrl,
      FLEET_DEPLOY_CONFIG: "../deployments/configs/token-governance-ci.json", FLEET_TOKEN_PROPOSALS: "true", FLEET_MANIFEST_OUT: "../token-governance-deployment.json" },
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60 * 1000,
  });
  if (run.status !== 0) {
    // Retain transaction receipts privately. Never publish raw Foundry logs or secrets.
    const diagnostic = (run.stdout ?? "") + (run.stderr ?? "");
    const redacted = Object.values(keys).reduce((out, key) => out.split(key).join("[private key]"), diagnostic.split(rpcUrl).join("[private RPC]"));
    console.error(redacted.slice(-5000));
    throw new Error("Contract deployment did not complete. Inspect the protected claim before retrying.");
  }
  const manifest = JSON.parse(readFileSync("token-governance-deployment.json", "utf8"));
  if (manifest.chainId !== 84532) throw new Error("Wrong manifest chain.");
  const budget = await recordProposalBudget(manifest);
  const record = { ...manifest, proposalBudget: budget, proposalEconomics: "erc20-burn-atomic", workflowRun: process.env.GITHUB_RUN_ID };
  await writeControlObject(manifestPath, record);
  writeFileSync("token-governance-deployment.json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ governor: manifest.addresses.governor, proposalBudget: budget.address, chainId: 84532 }));
}
deploy().catch(error => { console.error(error instanceof Error ? error.message : "Token governance deployment failed."); process.exitCode = 1; });
