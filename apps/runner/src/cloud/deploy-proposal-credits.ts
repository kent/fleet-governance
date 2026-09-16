import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { proposalCreditsAbi, proposalBudgetHookAbi, CREDIT_DEPLOYMENT } from "./proposal-credits.js";
import { readComputeObject } from "./compute-store.js";
import { writeControlObject } from "./compute-admin.js";
import { readSecret } from "./google.js";

/** Register only the authority created by the new Governor's immutable hook. */
export async function recordProposalBudget(config: { addresses: { governor: Hex; hook: Hex; token: Hex } }) {
  const reader = createPublicClient({ chain: baseSepolia, transport: http(await readSecret("fleet-base-sepolia-rpc-url")) });
  if (await reader.getChainId() !== 84532) throw new Error("Wrong chain.");
  const address = await reader.readContract({ address: config.addresses.hook, abi: proposalBudgetHookAbi, functionName: "proposalBudget" });
  const [governor, token, hook, operator, code, block] = await Promise.all([
    reader.readContract({ address, abi: proposalCreditsAbi, functionName: "governor" }),
    reader.readContract({ address, abi: proposalCreditsAbi, functionName: "token" }),
    reader.readContract({ address, abi: proposalCreditsAbi, functionName: "hook" }),
    reader.readContract({ address, abi: proposalCreditsAbi, functionName: "operator" }),
    reader.getCode({ address }), reader.getBlockNumber(),
  ]);
  if (!code || code === "0x" || governor.toLowerCase() !== config.addresses.governor.toLowerCase()
    || hook.toLowerCase() !== config.addresses.hook.toLowerCase() || token.toLowerCase() !== config.addresses.token.toLowerCase()) throw new Error("Proposal budget binding mismatch.");
  const record = { schema: "fleet.proposal-budget.v3", chainId: 84532, address, governor, hook, token, operator,
    codeHash: keccak256(code), observedBlock: block.toString(), revision: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID };
  const existing = await readComputeObject(CREDIT_DEPLOYMENT) as typeof record | null;
  if (existing && (existing.address !== address || existing.codeHash !== record.codeHash)) throw new Error("A different budget is already registered.");
  if (!existing) await writeControlObject(CREDIT_DEPLOYMENT, record);
  writeFileSync("proposal-credits-deployment.json", JSON.stringify(existing ?? record, null, 2));
  return existing ?? record;
}
if (process.argv[1]?.endsWith("deploy-proposal-credits.js")) {
  recordProposalBudget(JSON.parse(readFileSync("experiments/compute/base-sepolia-pilot.json", "utf8")))
    .then(record => console.log(JSON.stringify(record)))
    .catch(() => { console.error("Registering the proposal budget failed. Deploy the new token-governance contracts through CI first."); process.exitCode = 1; });
}
