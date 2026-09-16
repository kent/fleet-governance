import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { proposalCreditsAbi, CREDIT_DEPLOYMENT } from "./proposal-credits.js";
import { readComputeObject } from "./compute-store.js";
import { writeControlObject } from "./compute-admin.js";
import { readSecret } from "./google.js";

async function deploy() {
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const reader = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  if (await reader.getChainId() !== 84532) throw new Error("Wrong chain.");
  const existing = await readComputeObject(CREDIT_DEPLOYMENT) as { address: Hex; codeHash: Hex } | null;
  if (existing) {
    const code = await reader.getCode({ address: existing.address });
    if (!code || keccak256(code) !== existing.codeHash) throw new Error("Deployment changed.");
    writeFileSync("proposal-credits-deployment.json", JSON.stringify(existing, null, 2));
    return;
  }
  const config = JSON.parse(readFileSync("experiments/compute/base-sepolia-pilot.json", "utf8"));
  const bundle = JSON.parse(await readSecret("fleet-base-sepolia-wallets"));
  if (bundle.schema !== "fleet.wallets.v1" || bundle.chainId !== 84532) throw new Error("Wrong wallets.");
  const account = privateKeyToAccount(bundle.keys.FLEET_DEPLOYER_KEY);
  const operator = privateKeyToAccount(bundle.keys.FLEET_OPERATOR_KEY).address;
  // A retry after an ambiguous broadcast must not deploy and fund a second authority.
  await writeControlObject("contracts/proposal-credits-v2-claim.json", { at: new Date().toISOString(), workflowRun: process.env.GITHUB_RUN_ID });
  const artifact = JSON.parse(readFileSync("contracts/out/FleetProposalCredits.sol/FleetProposalCredits.json", "utf8"));
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const txHash = await wallet.deployContract({ abi: proposalCreditsAbi, bytecode: artifact.bytecode.object,
    args: [config.addresses.governor, config.addresses.token, operator], gas: 3000000n, maxFeePerGas: 100000000n });
  await writeControlObject("contracts/proposal-credits-v2-transaction.json", { txHash, workflowRun: process.env.GITHUB_RUN_ID });
  const receipt = await reader.waitForTransactionReceipt({ hash: txHash, confirmations: 3 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment failed.");
  const code = await reader.getCode({ address: receipt.contractAddress, blockNumber: receipt.blockNumber });
  if (!code || code === "0x") throw new Error("Missing contract code.");
  const record = { schema: "fleet.proposal-credits.v2", chainId: 84532, address: receipt.contractAddress,
    governor: config.addresses.governor, token: config.addresses.token, operator, codeHash: keccak256(code),
    deploymentBlock: receipt.blockNumber.toString(), txHash, revision: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID };
  await writeControlObject(CREDIT_DEPLOYMENT, record);
  writeFileSync("proposal-credits-deployment.json", JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
}

deploy().catch(() => { console.error("Proposal credit deployment failed. Claim and transaction records remain protected; no automatic redeployment. Private diagnostics withheld."); process.exitCode = 1; });
