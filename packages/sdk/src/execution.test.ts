import { describe, expect, it } from "vitest";
import { encodeFunctionData, keccak256, toHex } from "viem";
import type { Hex } from "viem";
import { fleetExecutorAbi } from "@fleet/abi";
import { ExecutionPermitV1 } from "@fleet/schemas";
import { buildDecisionDescription, verifyDescriptionAgainstCalldata } from "./description.js";
import { encodeRecordDecision } from "./actions.js";
import { decisionForExecution, decodeExecutePermit, encodeExecutePermit, executionPermitArgs, payloadHashForExecution } from "./execution.js";
import { FleetSigner, checkPolicy } from "./signer.js";
import { MemoryNonceStore, NonceManager } from "./nonce.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const permit = ExecutionPermitV1.parse({ schema: "fleet.execution-permit.v1", chainId: 31337,
  executor: address(1), ledger: address(2), taskId: "1", charterVersion: 1, actor: address(3),
  target: address(4), targetCodeHash: keccak256(toHex("code")), data: "0x11223344", nonce: "7", deadline: "2000000000" });
const policy = { chainId: 31337, governor: address(5), ledger: address(2), token: address(6), executor: address(1) };
const decision = decisionForExecution({ permit, proposerAgentId: 0, summary: "Publish the reviewed artifact", rationale: "Exact one-time publication" });
const calldata = encodeRecordDecision({ taskId: 1n, kind: "GRANT_EXCEPTION", expectedVersion: 1,
  payloadHash: decision.payloadHash as Hex, newCharterText: "", summary: decision.summary });

describe("execution permissions", () => {
  it("makes every domain and capability field part of the public commitment", () => {
    const hash = payloadHashForExecution(permit);
    const changes = { chainId: 31338, executor: address(8), ledger: address(8), taskId: "2", charterVersion: 2,
      actor: address(8), target: address(8), targetCodeHash: keccak256(toHex("other code")), data: "0x11223345", nonce: "8", deadline: "2000000001" };
    for (const [key, value] of Object.entries(changes)) expect(payloadHashForExecution({ ...permit, [key]: value })).not.toBe(hash);
  });

  it("refuses invalid or oversized permissions before encoding", () => {
    for (const change of [{ taskId: "0" }, { nonce: "01" }, { nonce: (2n ** 256n).toString() },
      { deadline: (2n ** 64n).toString() }, { data: "0x123456" }, { data: `0x${"11".repeat(8193)}` }]) {
      expect(() => encodeExecutePermit({ ...permit, ...change })).toThrow();
    }
  });

  it("verifies the public permission against the vote and configured deployment", () => {
    const description = buildDecisionDescription(decision, "engineer");
    expect(verifyDescriptionAgainstCalldata(description, calldata, { agentId: 0 }, policy)).toEqual({ ok: true });
    for (const context of [{ ...policy, chainId: 31338 }, { ...policy, ledger: address(9) },
      { ...policy, executor: address(9) }, { chainId: 31337, ledger: address(2) }]) {
      expect(verifyDescriptionAgainstCalldata(description, calldata, { agentId: 0 }, context).ok).toBe(false);
    }
    const modified = buildDecisionDescription({ ...decision, execution: { ...permit, data: "0x11223345" } }, "engineer");
    expect(verifyDescriptionAgainstCalldata(modified, calldata, { agentId: 0 }, policy).ok).toBe(false);
  });

  it("refuses a valid commitment attached to the wrong task or decision kind", () => {
    for (const kind of ["CHOOSE_PATH", "STOP_TASK", "AMEND_CHARTER"] as const) {
      const other = { ...decision, kind };
      const call = encodeRecordDecision({ taskId: 1n, kind, expectedVersion: 1, payloadHash: decision.payloadHash as Hex, newCharterText: "", summary: decision.summary });
      expect(verifyDescriptionAgainstCalldata(buildDecisionDescription(other, "engineer"), call, { agentId: 0 }, policy).ok).toBe(false);
    }
    const other = { ...decision, taskId: "2" };
    const call = encodeRecordDecision({ taskId: 2n, kind: "GRANT_EXCEPTION", expectedVersion: 1, payloadHash: decision.payloadHash as Hex, newCharterText: "", summary: decision.summary });
    expect(verifyDescriptionAgainstCalldata(buildDecisionDescription(other, "engineer"), call, { agentId: 0 }, policy).ok).toBe(false);
  });

  it("keeps execution disabled unless the signer opts into the deployment executor", () => {
    const call = { chainId: 31337, target: address(1), value: 0n, data: encodeExecutePermit(permit) };
    const { executor: _unused, ...disabled } = policy;
    expect(() => checkPolicy(disabled, call)).toThrow("not enabled");
    expect(() => checkPolicy(policy, call)).not.toThrow();
    expect(() => checkPolicy(policy, { ...call, target: address(9) })).toThrow("not the policy");
    expect(() => checkPolicy(policy, { ...call, value: 1n })).toThrow("non-zero");
  });

  it("rejects hidden or mismatched target bytes even in a canonically encoded outer call", () => {
    const malformed = encodeFunctionData({ abi: fleetExecutorAbi, functionName: "execute", args: [executionPermitArgs(permit), "0x11223345"] });
    expect(() => checkPolicy(policy, { chainId: 31337, target: address(1), value: 0n, data: malformed })).toThrow("hash mismatch");
    expect(() => decodeExecutePermit(`${encodeExecutePermit(permit)}00`)).toThrow("noncanonical");
  });

  it("rejects another actor or deployment before connecting to RPC", async () => {
    const rpcUrl = "http://127.0.0.1:1";
    const signer = new FleetSigner({ privateKey: `0x${"59".repeat(32)}`, rpcUrl, policy, nonces: new NonceManager(new MemoryNonceStore(), rpcUrl) });
    await expect(signer.executePermit(permit)).rejects.toThrow("only the permit actor");
    await expect(signer.executePermit({ ...permit, chainId: 31338 })).rejects.toThrow("another chain");
    await expect(signer.executePermit({ ...permit, ledger: address(9) })).rejects.toThrow("another executor or ledger");
  });
});
