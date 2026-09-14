import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  http,
  numberToHex,
} from "viem";
import type { AbiEvent, Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agoraGovernorAbi } from "@fleet/abi";
import type { FleetAddresses } from "./addresses.js";
import { FleetClient, ProposalState } from "./client.js";
import { Keeper } from "./keeper.js";

const CHAIN_ID = 31337;
const GOVERNOR = `0x${"a1".repeat(20)}` as Address;
const LEDGER = `0x${"a2".repeat(20)}` as Address;
const KEEPER_KEY = `0x${"77".repeat(32)}` as Hex;

const ADDRESSES: FleetAddresses = {
  registry: `0x${"b1".repeat(20)}` as Address,
  token: `0x${"b2".repeat(20)}` as Address,
  timelock: `0x${"b3".repeat(20)}` as Address,
  ledger: LEDGER,
  hook: `0x${"b4".repeat(20)}` as Address,
  governor: GOVERNOR,
};

const CALLDATA = `0x${"cc".repeat(36)}` as Hex; // stand-in recordDecision calldata; never decoded in these tests
const DESCRIPTION = "# Grant exception\n\nbody\n\n#proposalTypeId=0";
const PROPOSAL_ID = 99n;

const PROPOSAL_CREATED_EVENT = agoraGovernorAbi.find(
  (item): item is AbiEvent => item.type === "event" && item.name === "ProposalCreated",
);
if (!PROPOSAL_CREATED_EVENT) throw new Error("ProposalCreated event missing from agoraGovernorAbi (test setup)");

function proposalCreatedLog() {
  const topics = encodeEventTopics({ abi: [PROPOSAL_CREATED_EVENT], eventName: "ProposalCreated" });
  const data = encodeAbiParameters(
    PROPOSAL_CREATED_EVENT.inputs.map((i) => ({ type: i.type })),
    [PROPOSAL_ID, `0x${"d1".repeat(20)}` as Address, [LEDGER], [0n], [], [CALLDATA], 1n, 2n, DESCRIPTION],
  );
  return {
    address: GOVERNOR,
    topics,
    data,
    blockNumber: numberToHex(1),
    transactionHash: `0x${"33".repeat(32)}`,
    transactionIndex: "0x0",
    blockHash: `0x${"44".repeat(32)}`,
    logIndex: "0x0",
    removed: false,
  };
}

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
          throw new Error(`unstubbed RPC method in keeper test fake transport: ${body.method}`);
        }
        const result = handler(body.params ?? []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      } catch (err) {
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

/** Builds an `eth_call` handler for governor reads/simulations. `states` is consumed in order,
 *  one value per call to `state(proposalId)` (the last value repeats once exhausted), so a test
 *  can script the proposal moving between states across the several `state` reads one
 *  `reconcileProposal` call makes. `eta` answers `proposalEta`; `queueResult`/`executeResult`
 *  control what `queue`/`execute` simulation returns, or throw to simulate a revert. */
function governorEthCallHandler(opts: {
  states: number[];
  eta?: bigint;
  queueResult?: bigint | (() => never);
  executeResult?: bigint | (() => never);
}): Handler {
  let stateCallIndex = 0;
  return (params: unknown[]) => {
    const [call] = params as [{ to: Address; data: Hex }];
    const decoded = decodeFunctionData({ abi: agoraGovernorAbi, data: call.data });
    switch (decoded.functionName) {
      case "state": {
        const value = opts.states[Math.min(stateCallIndex, opts.states.length - 1)];
        stateCallIndex += 1;
        return encodeFunctionResult({ abi: agoraGovernorAbi, functionName: "state", result: value });
      }
      case "proposalSnapshot":
        return encodeFunctionResult({ abi: agoraGovernorAbi, functionName: "proposalSnapshot", result: 1n });
      case "proposalDeadline":
        return encodeFunctionResult({ abi: agoraGovernorAbi, functionName: "proposalDeadline", result: 2n });
      case "proposalEta":
        return encodeFunctionResult({ abi: agoraGovernorAbi, functionName: "proposalEta", result: opts.eta ?? 0n });
      case "queue":
        if (typeof opts.queueResult === "function") return opts.queueResult();
        return encodeFunctionResult({
          abi: agoraGovernorAbi,
          functionName: "queue",
          result: opts.queueResult ?? PROPOSAL_ID,
        });
      case "execute":
        if (typeof opts.executeResult === "function") return opts.executeResult();
        return encodeFunctionResult({
          abi: agoraGovernorAbi,
          functionName: "execute",
          result: opts.executeResult ?? PROPOSAL_ID,
        });
      default:
        throw new Error(`unexpected governor eth_call in keeper test: ${decoded.functionName}`);
    }
  };
}

function blockHandler(timestamp: bigint): Handler {
  return () => ({
    number: numberToHex(1),
    hash: `0x${"55".repeat(32)}`,
    timestamp: numberToHex(timestamp),
    baseFeePerGas: numberToHex(1_000_000_000),
    gasLimit: numberToHex(30_000_000),
  });
}

function buildKeeper(handlers: Record<string, Handler>): Promise<{
  keeper: Keeper;
  close: () => Promise<void>;
  calls: string[];
}> {
  return startFakeRpc(handlers).then((fake) => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: `fleet-keeper-${CHAIN_ID}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [fake.url] } },
    });
    const client = new FleetClient({ rpcUrl: fake.url, chainId: CHAIN_ID, addresses: ADDRESSES });
    const wallet = createWalletClient({ account: privateKeyToAccount(KEEPER_KEY), chain, transport: http(fake.url) });
    const keeper = new Keeper({ client, wallet, addresses: ADDRESSES });
    return { keeper, close: fake.close, calls: fake.calls };
  });
}

describe("Keeper.reconcileProposal", () => {
  let close: (() => Promise<void>) | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    await close?.();
    close = undefined;
  });

  it("Pending -> noop", async () => {
    const built = await buildKeeper({ eth_call: governorEthCallHandler({ states: [ProposalState.Pending] }) });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("noop");
  });

  it("Active -> noop", async () => {
    const built = await buildKeeper({ eth_call: governorEthCallHandler({ states: [ProposalState.Active] }) });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("noop");
  });

  it("Canceled -> canceled", async () => {
    const built = await buildKeeper({ eth_call: governorEthCallHandler({ states: [ProposalState.Canceled] }) });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("canceled");
  });

  it("Defeated -> defeated", async () => {
    const built = await buildKeeper({ eth_call: governorEthCallHandler({ states: [ProposalState.Defeated] }) });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("defeated");
  });

  it("Executed -> executed", async () => {
    const built = await buildKeeper({ eth_call: governorEthCallHandler({ states: [ProposalState.Executed] }) });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("executed");
  });

  it("Expired -> defeated (a queued proposal whose grace period elapsed will never execute)", async () => {
    const built = await buildKeeper({ eth_call: governorEthCallHandler({ states: [ProposalState.Expired] }) });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("defeated");
  });

  it("Succeeded -> queues the proposal and reports queued", async () => {
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({ states: [ProposalState.Succeeded, ProposalState.Succeeded] }),
      eth_getLogs: () => [proposalCreatedLog()],
      eth_sendRawTransaction: () => `0x${"66".repeat(32)}`,
      eth_getTransactionCount: () => numberToHex(0),
      eth_maxPriorityFeePerGas: () => numberToHex(1_000_000_000),
      eth_getBlockByNumber: blockHandler(1_700_000_000n),
      eth_estimateGas: () => numberToHex(200_000),
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("queued");
    expect(built.calls).toContain("eth_sendRawTransaction");
  });

  it("Succeeded, simulate queue reverts -> logs the explained revert and reports waiting", async () => {
    const HOOK_CALL_FAILED_SELECTOR = "0xa9e35b2f";
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({
        states: [ProposalState.Succeeded],
        queueResult: (): never => {
          // eslint-disable-next-line no-throw-literal
          throw { code: 3, message: "execution reverted", data: HOOK_CALL_FAILED_SELECTOR };
        },
      }),
      eth_getLogs: () => [proposalCreatedLog()],
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("waiting");
    expect(built.calls).not.toContain("eth_sendRawTransaction");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("HookCallFailed");
  });

  it("Succeeded, but another keeper already queued it before send -> reports queued without sending again", async () => {
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({ states: [ProposalState.Succeeded, ProposalState.Queued] }),
      eth_getLogs: () => [proposalCreatedLog()],
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("queued");
    expect(built.calls).not.toContain("eth_sendRawTransaction");
  });

  it("Succeeded, but another keeper already executed it before send -> reports the terminal state", async () => {
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({ states: [ProposalState.Succeeded, ProposalState.Executed] }),
      eth_getLogs: () => [proposalCreatedLog()],
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("executed");
    expect(built.calls).not.toContain("eth_sendRawTransaction");
  });

  it("Queued, eta not yet reached -> waiting", async () => {
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({ states: [ProposalState.Queued], eta: 2_000_000_000n }),
      eth_getBlockByNumber: blockHandler(1_700_000_000n),
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("waiting");
    expect(built.calls).not.toContain("eth_sendRawTransaction");
  });

  it("Queued, eta is zero (unset) -> waiting, without even checking the block timestamp", async () => {
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({ states: [ProposalState.Queued], eta: 0n }),
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("waiting");
    expect(built.calls).not.toContain("eth_getBlockByNumber");
  });

  it("Queued, eta reached -> executes the proposal and reports executed", async () => {
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({
        states: [ProposalState.Queued, ProposalState.Queued],
        eta: 1_000_000_000n,
      }),
      eth_getLogs: () => [proposalCreatedLog()],
      eth_getBlockByNumber: blockHandler(1_700_000_000n),
      eth_sendRawTransaction: () => `0x${"77".repeat(32)}`,
      eth_getTransactionCount: () => numberToHex(0),
      eth_maxPriorityFeePerGas: () => numberToHex(1_000_000_000),
      eth_estimateGas: () => numberToHex(200_000),
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("executed");
    expect(built.calls).toContain("eth_sendRawTransaction");
  });

  it("Queued, eta reached, simulate execute reverts -> logs the explained revert and reports waiting", async () => {
    const built = await buildKeeper({
      eth_call: governorEthCallHandler({
        states: [ProposalState.Queued],
        eta: 1_000_000_000n,
        executeResult: (): never => {
          // eslint-disable-next-line no-throw-literal
          throw { code: 3, message: "execution reverted", data: "0xdeadbeef" };
        },
      }),
      eth_getLogs: () => [proposalCreatedLog()],
      eth_getBlockByNumber: blockHandler(1_700_000_000n),
    });
    close = built.close;
    await expect(built.keeper.reconcileProposal(PROPOSAL_ID)).resolves.toBe("waiting");
    expect(built.calls).not.toContain("eth_sendRawTransaction");
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Keeper.reconcileProposal is safe to call repeatedly (idempotent)", () => {
  it("calling reconcileProposal again on an already-terminal proposal keeps reporting the same result", async () => {
    const built = await buildKeeper({ eth_call: governorEthCallHandler({ states: [ProposalState.Executed] }) });
    try {
      const first = await built.keeper.reconcileProposal(PROPOSAL_ID);
      const second = await built.keeper.reconcileProposal(PROPOSAL_ID);
      expect(first).toBe("executed");
      expect(second).toBe("executed");
      expect(built.calls).not.toContain("eth_sendRawTransaction");
    } finally {
      await built.close();
    }
  });
});
