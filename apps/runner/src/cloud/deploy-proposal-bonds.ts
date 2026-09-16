import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { proposalBondsAbi, bondHookAbi, bondVotesAbi, BOND_DEPLOYMENT } from "./proposal-bonds.js";
import { readComputeObject } from "./compute-store.js";
import { writeControlObject } from "./compute-admin.js";
import { readSecret } from "./google.js";

/** Register only the authority created by the new Governor's immutable hook. */
export async function recordProposalBonds(config: { addresses: { governor: Hex; hook: Hex; token: Hex } }) {
  const reader = createPublicClient({ chain: baseSepolia, transport: http(await readSecret("fleet-base-sepolia-rpc-url")) });
  if (await reader.getChainId() !== 84532) throw new Error("Wrong chain.");
  const address = await reader.readContract({ address: config.addresses.hook, abi: bondHookAbi, functionName: "proposalBonds" });
  const [governor, token, hook, operator, code, block] = await Promise.all([
    reader.readContract({ address, abi: proposalBondsAbi, functionName: "governor" }),
    reader.readContract({ address, abi: proposalBondsAbi, functionName: "token" }),
    reader.readContract({ address, abi: proposalBondsAbi, functionName: "hook" }),
    reader.readContract({ address, abi: proposalBondsAbi, functionName: "operator" }),
    reader.getCode({ address }), reader.getBlockNumber(),
  ]);
  if (!code || code === "0x" || governor.toLowerCase() !== config.addresses.governor.toLowerCase()
    || hook.toLowerCase() !== config.addresses.hook.toLowerCase() || token.toLowerCase() !== config.addresses.token.toLowerCase()) throw new Error("Proposal budget binding mismatch.");
  const boundController = await reader.readContract({ address: token, abi: bondVotesAbi, functionName: "bondController" });
  if (boundController.toLowerCase() !== address.toLowerCase()) throw new Error("FleetGov bond controller mismatch.");
  const record = { schema: "fleet.proposal-bonds.v4", chainId: 84532, address, governor, hook, token, operator,
    codeHash: keccak256(code), observedBlock: block.toString(), revision: process.env.GITHUB_SHA, workflowRun: process.env.GITHUB_RUN_ID };
  const existing = await readComputeObject(BOND_DEPLOYMENT) as typeof record | null;
  if (existing && (existing.address !== address || existing.codeHash !== record.codeHash)) throw new Error("A different budget is already registered.");
  if (!existing) await writeControlObject(BOND_DEPLOYMENT, record);
  writeFileSync("proposal-bonds-deployment.json", JSON.stringify(existing ?? record, null, 2));
  return existing ?? record;
}
