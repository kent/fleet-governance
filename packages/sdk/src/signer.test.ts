import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  toFunctionSelector,
} from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agoraGovernorAbi, fleetVotesAbi } from "@fleet/abi";
import { encodeRecordDecision } from "./actions.js";
import { MemoryNonceStore, NonceManager } from "./nonce.js";
import { FleetSigner, PolicyViolation, assertSize, checkPolicy } from "./signer.js";
import type { SignerPolicy } from "./signer.js";

const CHAIN_ID = 31337;
const GOVERNOR = `0x${"a1".repeat(20)}` as Address;
const LEDGER = `0x${"a2".repeat(20)}` as Address;
const TOKEN = `0x${"a3".repeat(20)}` as Address;
const PRIVATE_KEY = `0x${"59".repeat(32)}` as Hex;
const SAMPLE_HASH = `0x${"cd".repeat(32)}` as Hex;

const POLICY: SignerPolicy = { chainId: CHAIN_ID, governor: GOVERNOR, ledger: LEDGER, token: TOKEN };

function proposeCalldata(targets: Address[], values: bigint[], calldatas: Hex[], description: string): Hex {
  return encodeFunctionData({ abi: agoraGovernorAbi, functionName: "propose", args: [targets, values, calldatas, description] });
}

function castVoteCalldata(proposalId: bigint, support: 0 | 1 | 2, reason: string): Hex {
  return encodeFunctionData({ abi: agoraGovernorAbi, functionName: "castVoteWithReason", args: [proposalId, support, reason] });
}

function delegateCalldata(delegatee: Address): Hex {
  return encodeFunctionData({ abi: fleetVotesAbi, functionName: "delegate", args: [delegatee] });
}

const RECORD_DECISION_CALLDATA = encodeRecordDecision({
  taskId: 1n,
  kind: "GRANT_EXCEPTION",
  expectedVersion: 1,
  payloadHash: SAMPLE_HASH,
  newCharterText: "",
  summary: "Grant a one-time exception.",
});

describe("checkPolicy", () => {
  const validProposeData = proposeCalldata([LEDGER], [0n], [RECORD_DECISION_CALLDATA], "# desc\n\n#proposalTypeId=0");
  const validVoteData = castVoteCalldata(7n, 1, "FOR. looks fine");
  const validDelegateData = delegateCalldata(TOKEN);

  it("accepts a well-formed propose call", () => {
    expect(() =>
      checkPolicy(POLICY, { chainId: CHAIN_ID, target: GOVERNOR, value: 0n, data: validProposeData }),
    ).not.toThrow();
  });

  it("accepts a well-formed castVoteWithReason call", () => {
    expect(() =>
      checkPolicy(POLICY, { chainId: CHAIN_ID, target: GOVERNOR, value: 0n, data: validVoteData }),
    ).not.toThrow();
  });

  it("accepts a well-formed delegate call", () => {
    expect(() =>
      checkPolicy(POLICY, { chainId: CHAIN_ID, target: TOKEN, value: 0n, data: validDelegateData }),
    ).not.toThrow();
  });

  it("rejects a call declaring the wrong chain", () => {
    expect(() =>
      checkPolicy(POLICY, { chainId: CHAIN_ID + 1, target: GOVERNOR, value: 0n, data: validProposeData }),
    ).toThrow(PolicyViolation);
    try {
      checkPolicy(POLICY, { chainId: CHAIN_ID + 1, target: GOVERNOR, value: 0n, data: validProposeData });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyViolation);
      expect((err as PolicyViolation).code).toBe("CHAIN");
    }
  });

  it("rejects a call whose target is not the policy's contract for that function", () => {
    // Valid propose calldata, but sent to the token address instead of the governor.
    try {
      checkPolicy(POLICY, { chainId: CHAIN_ID, target: TOKEN, value: 0n, data: validProposeData });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyViolation);
      expect((err as PolicyViolation).code).toBe("TARGET");
    }
  });

  it("rejects a call whose selector is not propose, castVoteWithReason, or delegate", () => {
    const queueData = encodeFunctionData({
      abi: agoraGovernorAbi,
      functionName: "queue",
      args: [[LEDGER], [0n], [RECORD_DECISION_CALLDATA], SAMPLE_HASH],
    });
    try {
      checkPolicy(POLICY, { chainId: CHAIN_ID, target: GOVERNOR, value: 0n, data: queueData });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyViolation);
      expect((err as PolicyViolation).code).toBe("SELECTOR");
    }
  });

  it("rejects a non-zero value", () => {
    try {
      checkPolicy(POLICY, { chainId: CHAIN_ID, target: GOVERNOR, value: 1n, data: validProposeData });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyViolation);
      expect((err as PolicyViolation).code).toBe("VALUE");
    }
  });

  it("rejects calldata that does not decode canonically for its own selector", () => {
    // Keep the 4-byte propose() selector but truncate the body so it no longer decodes cleanly.
    const selector = toFunctionSelector("propose(address[],uint256[],bytes[],string)");
    const truncated = (selector + validProposeData.slice(10, 74)) as Hex;
    try {
      checkPolicy(POLICY, { chainId: CHAIN_ID, target: GOVERNOR, value: 0n, data: truncated });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyViolation);
      expect((err as PolicyViolation).code).toBe("RAW_CALLDATA");
    }
  });
});

describe("assertSize", () => {
  it("accepts a value within bounds", () => {
    expect(() => assertSize("reason", "ok", 1, 1024)).not.toThrow();
  });

  it("rejects a value under the minimum byte length", () => {
    try {
      assertSize("reason", "", 1, 1024);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyViolation);
      expect((err as PolicyViolation).code).toBe("SIZE");
    }
  });

  it("rejects a value over the maximum byte length", () => {
    try {
      assertSize("reason", "x".repeat(1025), 1, 1024);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyViolation);
      expect((err as PolicyViolation).code).toBe("SIZE");
    }
  });

  it("measures UTF-8 bytes, not JS string length (multi-byte characters count for more)", () => {
    // Each rocket emoji encodes to 4 UTF-8 bytes, so 256 of them is exactly 1024 bytes even
    // though the JS string length (.length, UTF-16 code units) is only 512.
    const atLimit = "🚀".repeat(256);
    expect(atLimit).toHaveLength(512);
    expect(() => assertSize("reason", atLimit, 1, 1024)).not.toThrow();
    expect(() => assertSize("reason", "🚀".repeat(257), 1, 1024)).toThrow(PolicyViolation);
  });
});

/** A tiny local JSON-RPC HTTP server standing in for a real chain, so `FleetSigner`'s
 *  `rpcUrl: string` constructor argument can point at canned, in-test responses. Handlers are
 *  looked up by RPC method name; an unstubbed method fails the request loudly rather than hanging,
 *  so a test only passes if the signer calls exactly the RPC methods it is expected to. */
type Handler = (params: unknown[]) => unknown;

function startFakeRpc(handlers: Record<string, Handler>): Promise<{ url: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let id: unknown = null;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: unknown;
          method: string;
          params?: unknown[];
        };
        id = body.id;
        calls.push(body.method);
        const handler = handlers[body.method];
        if (!handler) {
          throw new Error(`unstubbed RPC method in fake transport: ${body.method}`);
        }
        const result = handler(body.params ?? []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (err) {
        // A handler can throw a plain `{ code, message, data? }` object to simulate a real
        // JSON-RPC provider error (e.g. a contract revert, `data` carrying the revert bytes);
        // anything else (a bare `Error`, an unstubbed method) becomes a generic server error.
        const rpcError =
          err && typeof err === "object" && "code" in err && "message" in err
            ? (err as { code: number; message: string; data?: string })
            : { code: -32000, message: err instanceof Error ? err.message : String(err) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: rpcError }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        calls,
      });
    });
  });
}

describe("FleetSigner policy rejections against a fake transport", () => {
  let close: () => Promise<void>;

  afterEach(async () => {
    await close?.();
  });

  it("rejects before sending anything when the connected chain does not match the policy", async () => {
    const fake = await startFakeRpc({
      eth_chainId: () => numberToHex(CHAIN_ID + 1),
    });
    close = fake.close;

    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: fake.url,
      policy: POLICY,
      nonces: new NonceManager(new MemoryNonceStore(), fake.url),
    });

    await expect(
      signer.castVoteWithReason({ proposalId: 1n, support: 1, reason: "FOR. reasonable" }),
    ).rejects.toThrow(PolicyViolation);

    // Only the chain check itself should have run; no simulate/send RPC call was made.
    expect(fake.calls).toEqual(["eth_chainId"]);
  });

  it("rejects an oversized reason before making any RPC call at all", async () => {
    const fake = await startFakeRpc({});
    close = fake.close;

    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: fake.url,
      policy: POLICY,
      nonces: new NonceManager(new MemoryNonceStore(), fake.url),
    });

    await expect(
      signer.castVoteWithReason({ proposalId: 1n, support: 1, reason: "x".repeat(1025) }),
    ).rejects.toThrow(PolicyViolation);
    expect(fake.calls).toEqual([]);
  });

  it("rejects an oversized description before making any RPC call at all", async () => {
    const fake = await startFakeRpc({});
    close = fake.close;

    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: fake.url,
      policy: POLICY,
      nonces: new NonceManager(new MemoryNonceStore(), fake.url),
    });

    await expect(
      signer.propose({
        taskId: 1n,
        kind: "GRANT_EXCEPTION",
        expectedVersion: 1,
        payloadHash: SAMPLE_HASH,
        newCharterText: "",
        summary: "fine",
        description: "x".repeat(4097),
      }),
    ).rejects.toThrow(PolicyViolation);
    expect(fake.calls).toEqual([]);
  });

  it("rejects an oversized newCharterText before making any RPC call at all", async () => {
    const fake = await startFakeRpc({});
    close = fake.close;

    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: fake.url,
      policy: POLICY,
      nonces: new NonceManager(new MemoryNonceStore(), fake.url),
    });

    await expect(
      signer.propose({
        taskId: 1n,
        kind: "AMEND_CHARTER",
        expectedVersion: 1,
        payloadHash: SAMPLE_HASH,
        newCharterText: "x".repeat(8193),
        summary: "fine",
        description: "ok #proposalTypeId=0",
      }),
    ).rejects.toThrow(PolicyViolation);
    expect(fake.calls).toEqual([]);
  });

  it("rejects a summary over 1024 bytes before making any RPC call at all", async () => {
    const fake = await startFakeRpc({});
    close = fake.close;

    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: fake.url,
      policy: POLICY,
      nonces: new NonceManager(new MemoryNonceStore(), fake.url),
    });

    await expect(
      signer.propose({
        taskId: 1n,
        kind: "GRANT_EXCEPTION",
        expectedVersion: 1,
        payloadHash: SAMPLE_HASH,
        newCharterText: "",
        summary: "x".repeat(1025),
        description: "ok #proposalTypeId=0",
      }),
    ).rejects.toThrow(PolicyViolation);
    expect(fake.calls).toEqual([]);
  });

  it("does not reject an empty summary: TaskLedger and the spec only bound it from above", () => {
    // summary's lower bound changed from 1 to 0 bytes (review finding 2): the ledger and spec
    // only say "at most 1,024 bytes", so an empty summary is not a policy violation.
    expect(() => assertSize("summary", "", 0, 1024)).not.toThrow();
  });
});

describe("FleetSigner end to end against a fake transport", () => {
  let close: () => Promise<void>;

  afterEach(async () => {
    await close?.();
  });

  it("exposes the address derived from the given private key", () => {
    const fakeAccount = privateKeyToAccount(PRIVATE_KEY);
    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: "http://127.0.0.1:1",
      policy: POLICY,
      nonces: new NonceManager(new MemoryNonceStore(), "http://127.0.0.1:1"),
    });
    expect(signer.address.toLowerCase()).toBe(fakeAccount.address.toLowerCase());
  });

  it("predicts the proposal id, simulates, and sends", async () => {
    const PROPOSAL_ID = 4242n;
    const SENT_TX_HASH = `0x${"11".repeat(32)}` as Hex;

    const fake = await startFakeRpc({
      eth_chainId: () => numberToHex(CHAIN_ID),
      eth_getTransactionCount: () => numberToHex(0),
      eth_maxPriorityFeePerGas: () => numberToHex(1_000_000_000),
      eth_getBlockByNumber: () => ({
        baseFeePerGas: numberToHex(1_000_000_000),
        gasLimit: numberToHex(30_000_000),
        number: numberToHex(1),
        hash: `0x${"22".repeat(32)}`,
        timestamp: numberToHex(1_700_000_000),
      }),
      eth_call: (params) => {
        const [call] = params as [{ to: Address; data: Hex }];
        const decoded = decodeFunctionData({ abi: agoraGovernorAbi, data: call.data });
        if (decoded.functionName === "getProposalId" || decoded.functionName === "propose") {
          return encodeFunctionResult({ abi: agoraGovernorAbi, functionName: decoded.functionName, result: PROPOSAL_ID });
        }
        throw new Error(`unexpected eth_call functionName in test: ${decoded.functionName}`);
      },
      eth_sendRawTransaction: () => SENT_TX_HASH,
    });
    close = fake.close;

    const policy: SignerPolicy = { ...POLICY, maxGas: 500_000n };
    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: fake.url,
      policy,
      nonces: new NonceManager(new MemoryNonceStore(), fake.url),
    });

    const result = await signer.propose({
      taskId: 1n,
      kind: "GRANT_EXCEPTION",
      expectedVersion: 1,
      payloadHash: SAMPLE_HASH,
      newCharterText: "",
      summary: "Grant a one-time exception for the integration test.",
      description: "# Grant exception\n\nsome body\n\n#proposalTypeId=0",
    });

    expect(result.proposalId).toBe(PROPOSAL_ID);
    expect(result.txHash).toBe(SENT_TX_HASH);
    expect(fake.calls).toContain("eth_sendRawTransaction");
  });

  it("surfaces a hook rejection through explainRevert instead of an opaque revert", async () => {
    const HOOK_CALL_FAILED_SELECTOR = "0xa9e35b2f";

    const fake = await startFakeRpc({
      eth_chainId: () => numberToHex(CHAIN_ID),
      eth_getTransactionCount: () => numberToHex(0),
      eth_call: (params) => {
        const [call] = params as [{ to: Address; data: Hex }];
        const decoded = decodeFunctionData({ abi: agoraGovernorAbi, data: call.data });
        if (decoded.functionName === "getProposalId") {
          return encodeFunctionResult({ abi: agoraGovernorAbi, functionName: "getProposalId", result: 1n });
        }
        // Simulate FleetHook rejecting the propose() simulation with HookCallFailed().
        throw { code: 3, message: "execution reverted", data: HOOK_CALL_FAILED_SELECTOR };
      },
    });
    close = fake.close;

    const signer = new FleetSigner({
      privateKey: PRIVATE_KEY,
      rpcUrl: fake.url,
      policy: POLICY,
      nonces: new NonceManager(new MemoryNonceStore(), fake.url),
    });

    await expect(
      signer.propose({
        taskId: 1n,
        kind: "GRANT_EXCEPTION",
        expectedVersion: 1,
        payloadHash: SAMPLE_HASH,
        newCharterText: "",
        summary: "Grant a one-time exception.",
        description: "# Grant exception\n\nbody\n\n#proposalTypeId=0",
      }),
    ).rejects.toThrow(/HookCallFailed/);
  });
});
