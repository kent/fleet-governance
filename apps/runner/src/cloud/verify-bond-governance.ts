import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeEventLog, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { agoraGovernorAbi, taskLedgerAbi, fleetVotesAbi } from "@fleet/abi";
import { encodeRecordDecision } from "@fleet/sdk";
import { proposalBondsAbi, bondVotesAbi } from "./proposal-bonds.js";
import { readComputeAllocation, readComputeObject } from "./compute-store.js";
import { writeControlObject, COMPUTE_TARGET } from "./compute-admin.js";
import { googleRequest, readSecret } from "./google.js";

/** Scripted protocol transactions. These are never presented as model-agent votes. */
async function verify() {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("CI only.");
  const root = "contracts/bond-governance-v4";
  const saved = await readComputeObject(`${root}-verification.json`);
  if (saved) { writeFileSync("bond-governance-verification.json", JSON.stringify(saved, null, 2)); return; }
  if (await readComputeObject(`${root}-verification-claim.json`)) throw new Error("Reconcile the earlier verification claim before retrying.");
  const vm = await (await googleRequest("compute", COMPUTE_TARGET)).json() as { status: string };
  if (vm.status !== "TERMINATED" || await readComputeAllocation() || await readComputeObject("simulation-queue.json")) throw new Error("Retire agent compute first.");
  const manifest = await readComputeObject(`${root}.json`) as { addresses: { governor: Hex; ledger: Hex; token: Hex }; proposalBonds: { address: Hex; codeHash: Hex } } | null;
  if (!manifest) throw new Error("Deploy single-token governance first.");
  const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
  const reader = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const bundle = JSON.parse(await readSecret("fleet-base-sepolia-wallets"));
  if (await reader.getChainId() !== 84532 || bundle.schema !== "fleet.wallets.v1" || bundle.chainId !== 84532) throw new Error("Wrong chain or wallets.");
  const wallets = Array.from({ length: 5 }, (_, i) => createWalletClient({ account: privateKeyToAccount(bundle.keys[`FLEET_AGENT_KEY_${i}`]), chain: baseSepolia, transport: http(rpcUrl) }));
  const operator = createWalletClient({ account: privateKeyToAccount(bundle.keys.FLEET_OPERATOR_KEY), chain: baseSepolia, transport: http(rpcUrl) });
  const { governor, ledger, token } = manifest.addresses, bank = manifest.proposalBonds.address, one = 10n ** 18n, amount = one / 10n;
  const code = await reader.getBytecode({ address: bank });
  if (!code || keccak256(code) !== manifest.proposalBonds.codeHash) throw new Error("Wrong bond controller.");
  await writeControlObject(`${root}-verification-claim.json`, { workflowRun: process.env.GITHUB_RUN_ID });
  const transactions: Hex[] = [];
  const confirmed = async (hash: Hex) => {
    transactions.push(hash);
    await writeControlObject(`${root}-proof-tx-${transactions.length}.json`, { hash });
    const receipt = await reader.waitForTransactionReceipt({ hash, confirmations: 3 });
    if (receipt.status !== "success") throw new Error("Bond protocol transaction reverted.");
    return receipt;
  };
  const charter = JSON.parse(readFileSync("experiments/fixtures/charters/coding-task.v1.json", "utf8"));
  charter.goal = "Scripted bond protocol acceptance. No model agents or compute allocation. Verify losing-proposal refunds and cancellation/low-participation penalties.";
  const opened = await confirmed(await operator.writeContract({ address: ledger, abi: taskLedgerAbi, functionName: "openTask", args: [JSON.stringify(charter),3600n], gas: 700000n, maxFeePerGas: 10000000n }));
  const event = opened.logs.flatMap(log => { try { return [decodeEventLog({ abi: taskLedgerAbi, eventName: "TaskOpened", data: log.data, topics: log.topics })]; } catch { return []; } })[0];
  if (!event) throw new Error("Missing task receipt.");
  const taskId = event.args.taskId;
  await confirmed(await operator.writeContract({ address: bank, abi: proposalBondsAbi, functionName: "registerRunPolicy",
    args: [taskId, keccak256(toHex("fleet-bond-v4-protocol-test")), (await reader.getBlock()).timestamp + 3300n, amount, one, 60, 6000, wallets.map(w => w.account.address)], gas: 2500000n, maxFeePerGas: 10000000n }));
  const submit = async (index: number, label: string) => {
    const data = encodeRecordDecision({ taskId, kind: "CHOOSE_PATH", expectedVersion: 1, payloadHash: keccak256(toHex(label)), newCharterText: "", summary: label });
    const args = [[ledger], [0n], [data], `# ${label}\n\nSCRIPTED PROTOCOL TEST. CI sends these votes to verify FleetGov proposal bonds. These are not model-generated decisions.\n\n#proposalTypeId=0`] as const;
    const id = await reader.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "getProposalId", args: [args[0],args[1],args[2],keccak256(toHex(args[3]))] });
    const receipt = await confirmed(await wallets[index]!.writeContract({ address: governor, abi: agoraGovernorAbi, functionName: "propose", args, gas: 1400000n, maxFeePerGas: 10000000n }));
    const [reserved, balance, power] = await Promise.all([
      reader.readContract({ address: token, abi: bondVotesAbi, functionName: "bonded", args: [wallets[index]!.account.address] }),
      reader.readContract({ address: token, abi: bondVotesAbi, functionName: "balanceOf", args: [wallets[index]!.account.address] }),
      reader.readContract({ address: token, abi: fleetVotesAbi, functionName: "getVotes", args: [wallets[index]!.account.address] }),
    ]);
    if (reserved !== amount || balance !== one || power !== one) throw new Error("Reservation did not preserve votes and collateral.");
    return { id, args, txHash: receipt.transactionHash };
  };
  const cancelled = await submit(0, "Cancellation forfeits the FleetGov bond");
  await confirmed(await wallets[0]!.writeContract({ address: governor, abi: agoraGovernorAbi, functionName: "cancel", args: [cancelled.args[0],cancelled.args[1],cancelled.args[2],keccak256(toHex(cancelled.args[3]))], gas: 300000n, maxFeePerGas: 10000000n }));
  await confirmed(await operator.writeContract({ address: bank, abi: proposalBondsAbi, functionName: "settle", args: [cancelled.id], gas: 500000n, maxFeePerGas: 10000000n }));
  const losing = await submit(1, "All AGAINST with participation returns the bond");
  const quiet = await submit(2, "Insufficient participation forfeits the bond");
  const snapshot = await reader.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "proposalSnapshot", args: [quiet.id] });
  while ((await reader.getBlock()).timestamp <= snapshot) await new Promise(resolve => setTimeout(resolve,2000));
  for (const [i,wallet] of wallets.entries()) await confirmed(await wallet.writeContract({ address: governor, abi: agoraGovernorAbi, functionName: "castVoteWithReason", args: [losing.id,0,`Agent${i+1}: scripted protocol test. Vote AGAINST to verify that participation returns a losing proposal's bond. Voting costs no bond.`], gas: 350000n, maxFeePerGas: 10000000n }));
  await confirmed(await wallets[2]!.writeContract({ address: governor, abi: agoraGovernorAbi, functionName: "castVoteWithReason", args: [quiet.id,2,"Scripted protocol test: one ABSTAIN is below the three-token refund participation threshold."], gas: 350000n, maxFeePerGas: 10000000n }));
  const deadline = await reader.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "proposalDeadline", args: [quiet.id] });
  while ((await reader.getBlock()).timestamp <= deadline) await new Promise(resolve => setTimeout(resolve,3000));
  for (const id of [losing.id,quiet.id]) await confirmed(await operator.writeContract({ address: bank, abi: proposalBondsAbi, functionName: "settle", args: [id], gas: 500000n, maxFeePerGas: 10000000n }));
  const proposals = [];
  for (const [p, expected] of [[cancelled,2],[losing,1],[quiet,2]] as const) {
    const receipt = await reader.readContract({ address: bank, abi: proposalBondsAbi, functionName: "receipts", args: [p.id] });
    const state = await reader.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "state", args: [p.id] });
    const votes = await reader.readContract({ address: governor, abi: agoraGovernorAbi, functionName: "proposalVotes", args: [p.id] });
    if (receipt[5] !== expected || state !== (p === cancelled ? 2 : 3)) throw new Error("Bond outcome did not match participation.");
    proposals.push({ proposalId: p.id.toString(), txHash: p.txHash, state, settlement: expected === 1 ? "returned" : "forfeited", votes: votes.map(String) });
  }
  const [supply, treasury, agent0Power, agent1Balance, agent2Power, outstanding] = await Promise.all([
    reader.readContract({ address: token, abi: bondVotesAbi, functionName: "totalSupply" }),
    reader.readContract({ address: token, abi: bondVotesAbi, functionName: "balanceOf", args: [bank] }),
    reader.readContract({ address: token, abi: fleetVotesAbi, functionName: "getVotes", args: [wallets[0]!.account.address] }),
    reader.readContract({ address: token, abi: bondVotesAbi, functionName: "balanceOf", args: [wallets[1]!.account.address] }),
    reader.readContract({ address: token, abi: fleetVotesAbi, functionName: "getVotes", args: [wallets[2]!.account.address] }),
    reader.readContract({ address: token, abi: bondVotesAbi, functionName: "totalBonded" }),
  ]);
  if (supply !== 5n*one || treasury !== 2n*amount || agent0Power !== one-amount || agent1Balance !== one || agent2Power !== one-amount || outstanding !== 0n) throw new Error("Fixed supply or bond penalty accounting failed.");
  await confirmed(await operator.writeContract({ address: bank, abi: proposalBondsAbi, functionName: "closeRun", args: [taskId], gas: 400000n, maxFeePerGas: 10000000n }));
  const proof = { chainId: 84532, scripted: true, modelAgents: false, governor, token, bondController: bank, taskId: taskId.toString(), proposals,
    totalSupply: supply.toString(), nonVotingTreasury: treasury.toString(), reservedTokensKeepVotes: true, losingProposalRefunded: true,
    cancellationAndInsufficientParticipationForfeited: true, penaltiesReduceFutureVotingPower: true, oldPolicyClosed: true, transactions, workflowRun: process.env.GITHUB_RUN_ID };
  await writeControlObject(`${root}-verification.json`,proof);
  writeFileSync("bond-governance-verification.json", JSON.stringify(proof,null,2));
  console.log(JSON.stringify(proof));
}
verify().catch(() => { console.error("Bond protocol verification stopped. Reconcile its protected transaction journal before retrying."); process.exitCode=1; });
