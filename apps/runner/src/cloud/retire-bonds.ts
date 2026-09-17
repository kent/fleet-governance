import { createPublicClient, createWalletClient, http, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { logBoundedHttp } from "@fleet/sdk";
import type { ComputeAllocation } from "./compute-policy.js";
import { readComputeObject } from "./compute-store.js";
import { writeControlObject } from "./compute-admin.js";
import { readSecret } from "./google.js";
import { proposalBondsAbi } from "./proposal-bonds.js";
import { runEvent } from "./run-events.js";

/** Called only after protected batch retirement verifies the exact worker is off.
 * Settlement is permissionless, so a stopped or uncooperative worker cannot trap bonds. */
export async function retireExperimentBonds(allocation: ComputeAllocation) {
  if (!allocation.discovery?.proposalBonds) return;
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Bond retirement runs through GitHub CI.");
  const path = `simulations/${allocation.runId}/bonds.json`;
  if (await readComputeObject(path)) return;
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const reader = createPublicClient({ chain: baseSepolia, transport: logBoundedHttp(rpcUrl, BigInt(allocation.discovery.startBlock)) });
  const bundle = JSON.parse(await readSecret("fleet-base-sepolia-wallets"));
  if (bundle.schema !== "fleet.wallets.v1" || bundle.chainId !== 84532 || await reader.getChainId() !== 84532) throw new Error("Wrong bond retirement chain or wallets.");
  const wallet = createWalletClient({ account: privateKeyToAccount(bundle.keys.FLEET_OPERATOR_KEY as Hex), chain: baseSepolia, transport: http(rpcUrl) });
  const bank = allocation.discovery.creditsContract as Hex, taskId = BigInt(allocation.discovery.taskId);
  const code = await reader.getBytecode({ address: bank });
  const [governor, token, operator, run, count] = await Promise.all([
    reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "governor" }),
    reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "token" }),
    reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "operator" }),
    reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "runs", args: [taskId] }),
    reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "proposalCount", args: [taskId] }),
  ]);
  if (!code || keccak256(code) !== allocation.discovery.creditsCodeHash || governor.toLowerCase() !== allocation.governor.toLowerCase()
    || token.toLowerCase() !== allocation.discovery.proposalBonds.token.toLowerCase() || operator.toLowerCase() !== wallet.account.address.toLowerCase()
    || run[0] !== allocation.discovery.runHash || count > 64n) throw new Error("Bond retirement authority changed.");
  const confirmed = async (hash: Hex) => {
    const receipt = await reader.waitForTransactionReceipt({ hash, confirmations: 3 });
    if (receipt.status !== "success") throw new Error("Bond retirement transaction failed.");
  };
  for (let i = 0n; i < count; i++) {
    const id = await reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "proposalAt", args: [taskId, i] });
    const receipt = await reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "receipts", args: [id] });
    if (receipt[5] === 0) await confirmed(await wallet.writeContract({ address: bank, abi: proposalBondsAbi, functionName: "settle", args: [id], gas: 400000n, maxFeePerGas: 100000000n }));
  }
  if (!run[6]) await confirmed(await wallet.writeContract({ address: bank, abi: proposalBondsAbi, functionName: "closeRun", args: [taskId], gas: 1500000n, maxFeePerGas: 100000000n }));
  const logs = await reader.getContractEvents({ address: bank, abi: proposalBondsAbi, eventName: "ProposalBondSettled",
    args: { taskId }, fromBlock: BigInt(allocation.discovery.startBlock), strict: true });
  if (BigInt(logs.length) !== count) throw new Error("Missing bond settlement evidence.");
  const events = logs.map(log => runEvent(allocation.runId, { component: "governance", type: "bond.retirement_verified", proposalId: log.args.proposalId.toString(),
    txHash: log.transactionHash, blockNumber: log.blockNumber.toString(), title: `FleetGov bond ${log.args.settlement === 1 ? "returned" : "forfeited"}`,
    detail: "GitHub independently read the onchain settlement after the agent VM stopped. The old proposal policy is permanently closed; no new experiment was started.",
    evidence: { amount: log.args.amount.toString(), settlement: log.args.settlement, proposer: log.args.proposer,
      participation: log.args.participation.toString(), requiredParticipation: log.args.requiredParticipation.toString() } }));
  await writeControlObject(path, { runId: allocation.runId, allocationId: allocation.allocationId, taskId: taskId.toString(), bank, token,
    closed: true, events, workflowRun: process.env.GITHUB_RUN_ID, observedAt: new Date().toISOString() });
}
