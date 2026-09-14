import { createWalletClient, encodeFunctionData, http, keccak256, toHex } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fleetExecutorAbi, governedArtifactStoreAbi } from "@fleet/abi";
import { ExecutionPermitV1, FixtureV1 } from "@fleet/schemas";
import { FleetSigner, MemoryNonceStore, NonceManager, encodeExecutePermit, executionPermitArgs, payloadHashForExecution } from "@fleet/sdk";
import type { FleetClient } from "@fleet/sdk";
import type { FeeEntry, FleetKeys } from "./pipeline/fixture-runner.js";

export async function executionFixture(client: FleetClient, taskId: bigint, base: FixtureV1, scenario: number): Promise<FixtureV1> {
  const { executor, artifactStore } = client.addresses;
  if (!executor || !artifactStore) throw new Error("deployment has no contract execution resources");
  const task = await client.getTask(taskId);
  const actor = (await client.listMembers())[0]!;
  const code = await client.publicClient.getCode({ address: artifactStore });
  if (!code) throw new Error("artifact store has no deployed code");
  const digest = keccak256(toHex(scenario === 0 ? "unreviewed artifact" : "reviewed artifact"));
  const permit = ExecutionPermitV1.parse({ schema: "fleet.execution-permit.v1", chainId: client.chainId,
    executor, ledger: client.addresses.ledger, taskId: taskId.toString(), charterVersion: task.charterVersion,
    actor: actor.account, target: artifactStore, targetCodeHash: keccak256(code),
    data: encodeFunctionData({ abi: governedArtifactStoreAbi, functionName: "publish", args: [digest] }),
    nonce: String(scenario), deadline: task.expiresAt.toString() });
  const contractHash = await client.publicClient.readContract({ address: executor, abi: fleetExecutorAbi, functionName: "hashPermit", args: [executionPermitArgs(permit)] });
  if (contractHash !== payloadHashForExecution(permit)) throw new Error("SDK and contract disagree on execution commitment");
  return FixtureV1.parse({ schema: "fleet.fixture.v1", name: scenario === 0 ? "execution-rejected" : "execution-approved",
    description: "Scripted contract enforcement test. Every member sees the complete one-time artifact publication permission; votes are prescribed for this machinery test.",
    trigger: { agentId: 0, kind: "GRANT_EXCEPTION", execution: permit,
      summary: scenario === 0 ? "Publish an unreviewed artifact" : "Publish the reviewed artifact" }, script: base.script,
    expected: { outcome: scenario === 0 ? "Defeated" : "Executed", decisionCount: scenario === 0 ? 0 : 1, missingVotes: 0 } });
}

/** This probe uses only keys on the harness's owned Anvil. In addition to signer simulations,
 * it deliberately mines failing transactions so the chain receipts prove contract rejection. */
export async function probeExecution(client: FleetClient, rpcUrl: string, keys: FleetKeys, fixture: FixtureV1) {
  const permit = fixture.trigger.execution!;
  const executor = client.addresses.executor!;
  const store = client.addresses.artifactStore!;
  const actorKey = keys.agentKeys[fixture.trigger.agentId]!;
  const rpc = client.publicClient;
  const fees: FeeEntry[] = [];
  const checks: { name: string; txHash: Hex; status: string; simulation: string }[] = [];
  const signer = () => new FleetSigner({ privateKey: actorKey, rpcUrl,
    policy: { chainId: client.chainId, governor: client.addresses.governor, ledger: client.addresses.ledger, token: client.addresses.token, executor },
    nonces: new NonceManager(new MemoryNonceStore(), rpcUrl) });
  const receipt = async (hash: Hex) => {
    const r = await rpc.waitForTransactionReceipt({ hash });
    fees.push({ txHash: hash, gasUsed: r.gasUsed.toString(), effectiveGasPrice: r.effectiveGasPrice.toString(), feeWei: (r.gasUsed * r.effectiveGasPrice).toString() });
    return r;
  };
  const blocked = async (name: string, expected: string, simulate: () => Promise<unknown>, to: Hex, data: Hex, key = actorKey) => {
    let simulation = "";
    try { await simulate(); } catch (error) { simulation = error instanceof Error ? error.message : String(error); }
    if (!simulation.includes(expected)) throw new Error(`${name}: expected ${expected}, got ${simulation || "success"}`);
    const wallet = createWalletClient({ account: privateKeyToAccount(key), chain: rpc.chain!, transport: http(rpcUrl) });
    const txHash = await wallet.sendTransaction({ to, data, gas: 500_000n });
    const mined = await receipt(txHash);
    if (mined.status !== "reverted") throw new Error(`${name}: unauthorized transaction succeeded`);
    checks.push({ name, txHash, status: mined.status, simulation });
  };
  await blocked("operator direct publication", "NotExecutor", () => rpc.simulateContract({ account: privateKeyToAccount(keys.operatorKey), address: store,
    abi: governedArtifactStoreAbi, functionName: "publish", args: [keccak256(toHex("operator override"))] }),
  store, encodeFunctionData({ abi: governedArtifactStoreAbi, functionName: "publish", args: [keccak256(toHex("operator override"))] }), keys.operatorKey);

  const approved = fixture.expected.outcome === "Executed";
  if (approved) {
    const changed = { ...permit, data: encodeFunctionData({ abi: governedArtifactStoreAbi, functionName: "publish", args: [keccak256(toHex("substituted artifact"))] }) };
    await blocked("changed publication", "NotApproved", () => signer().executePermit(changed), executor, encodeExecutePermit(changed));
    const submitted = await signer().executePermit(permit);
    const mined = await receipt(submitted.txHash);
    if (mined.status !== "success") throw new Error("approved permission failed to execute");
    checks.push({ name: "approved exact publication", txHash: submitted.txHash, status: mined.status, simulation: "approved" });
    await blocked("replayed publication", "AlreadyConsumed", () => signer().executePermit(permit), executor, encodeExecutePermit(permit));
  } else {
    await blocked("defeated publication", "NotApproved", () => signer().executePermit(permit), executor, encodeExecutePermit(permit));
  }
  const [digest, revision] = await rpc.readContract({ address: store, abi: governedArtifactStoreAbi, functionName: "artifacts", args: [BigInt(permit.taskId)] });
  const expectedDigest = approved ? keccak256(toHex("reviewed artifact")) : `0x${"00".repeat(32)}`;
  if (revision !== BigInt(Number(approved)) || digest !== expectedDigest) throw new Error("artifact state disagrees with the approved exact publication");
  const consumed = await rpc.readContract({ address: executor, abi: fleetExecutorAbi, functionName: "consumed", args: [payloadHashForExecution(permit)] });
  if (consumed !== approved) throw new Error("permit consumption disagrees with execution");
  return { taskId: permit.taskId, payloadHash: payloadHashForExecution(permit), checks, artifact: { digest, revision: revision.toString() }, consumed, fees };
}
