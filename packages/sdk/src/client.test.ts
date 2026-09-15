import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { numberToHex } from "viem";
import type { Address } from "viem";
import { ChainNotAllowedError } from "@fleet/schemas";
import { FleetClient } from "./client.js";
import type { FleetAddresses } from "./addresses.js";

const ADDRESSES: FleetAddresses = {
  registry: `0x${"a1".repeat(20)}` as Address,
  token: `0x${"a2".repeat(20)}` as Address,
  timelock: `0x${"a3".repeat(20)}` as Address,
  ledger: `0x${"a4".repeat(20)}` as Address,
  hook: `0x${"a5".repeat(20)}` as Address,
  governor: `0x${"a6".repeat(20)}` as Address,
};

describe("task reads after confirmed creation", () => {
  afterEach(() => vi.restoreAllMocks());
  it("pins the task and charter to the receipt block even when latest is stale", async () => {
    const client = new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 84532, addresses: ADDRESSES });
    const read = vi.spyOn(client.publicClient, "readContract").mockImplementation(async call => {
      if (call.blockNumber !== 123n) throw new Error("Task missing at stale latest head");
      return call.functionName === "getTask" ? { id: 3n, charterVersion: 1 } : '{"schema":"fleet.charter.v1"}';
    });
    await expect(client.getTask(3n, 123n)).resolves.toMatchObject({ id: 3n, charterVersion: 1 });
    expect(read.mock.calls.map(([call]) => [call.functionName, call.blockNumber])).toEqual([["getTask", 123n], ["charterText", 123n]]);
    await expect(client.getTask(3n)).rejects.toThrow("stale latest");
  });
  it("reads all proposal timing fields at the confirmed proposal block", async () => {
    const client = new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 84532, addresses: ADDRESSES });
    const read = vi.spyOn(client.publicClient, "readContract").mockImplementation(async call => {
      if (call.blockNumber !== 124n) throw new Error("Proposal missing at stale latest head");
      return call.functionName === "proposalSnapshot" ? 1000n : call.functionName === "proposalDeadline" ? 1300n : 0n;
    });
    await expect(client.getProposalTiming(7n, 124n)).resolves.toEqual({ snapshot: 1000n, deadline: 1300n, eta: 0n });
    expect(read.mock.calls.map(([call]) => call.blockNumber)).toEqual([124n, 124n, 124n]);
  });
});

describe("single member resolution", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves a high agent id with constant RPC work", async () => {
    const client = new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 31337, addresses: ADDRESSES });
    const read = vi.spyOn(client.publicClient, "readContract")
      .mockResolvedValueOnce(true).mockResolvedValueOnce(2000n).mockResolvedValueOnce('{"role":"critic"}');
    await expect(client.getMember(ADDRESSES.token)).resolves.toEqual({ agentId: 2000, account: ADDRESSES.token, manifest: '{"role":"critic"}' });
    expect(read.mock.calls.map(([call]) => call.functionName)).toEqual(["isMember", "idOf", "agentManifest"]);
    expect(read.mock.calls[2]?.[0].args).toEqual([2000n]);
  });

  it("gives a partial roster no membership authority", async () => {
    const client = new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 31337, addresses: ADDRESSES });
    const read = vi.spyOn(client.publicClient, "readContract").mockResolvedValueOnce(false);
    await expect(client.getMember(ADDRESSES.token)).resolves.toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it("preserves RPC errors rather than treating an unreadable identity as absent", async () => {
    const client = new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 31337, addresses: ADDRESSES });
    vi.spyOn(client.publicClient, "readContract").mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(client.getMember(ADDRESSES.token)).rejects.toThrow("RPC unavailable");
  });
});

/** The smallest possible JSON-RPC endpoint: answers `eth_chainId` with `chainId` and nothing
 *  else, which is all `FleetClient.assertChain` ever asks for. */
async function startChainIdRpc(chainId: number): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as { id: number; method: string };
      res.writeHead(200, { "content-type": "application/json" });
      if (body.method === "eth_chainId") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: numberToHex(chainId) }));
        return;
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: body.method } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

describe("FleetClient chain guards (final review I2 and M7)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("refuses to construct a client for Base mainnet", () => {
    expect(() => new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 8453, addresses: ADDRESSES })).toThrow(
      "Base mainnet (8453) is refused in v1",
    );
  });

  it("refuses to construct a client for any chain outside the allowlist", () => {
    expect(() => new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 1, addresses: ADDRESSES })).toThrow(
      ChainNotAllowedError,
    );
  });

  it("constructs for the two allowed chains", () => {
    expect(() => new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 31337, addresses: ADDRESSES })).not.toThrow();
    expect(() => new FleetClient({ rpcUrl: "http://127.0.0.1:1", chainId: 84532, addresses: ADDRESSES })).not.toThrow();
  });

  it("assertChain resolves when the RPC reports the configured chain", async () => {
    const rpc = await startChainIdRpc(31337);
    close = rpc.close;
    const client = new FleetClient({ rpcUrl: rpc.url, chainId: 31337, addresses: ADDRESSES });
    await expect(client.assertChain()).resolves.toBeUndefined();
  });

  it("assertChain rejects when the RPC is a different chain than the manifest said", async () => {
    // The exact M7 failure: a keeper or gateway pointed at the wrong RPC would otherwise read a
    // different chain's ledger and report its state as this fleet's.
    const rpc = await startChainIdRpc(84532);
    close = rpc.close;
    const client = new FleetClient({ rpcUrl: rpc.url, chainId: 31337, addresses: ADDRESSES });
    await expect(client.assertChain()).rejects.toThrow(/reports chain id 84532.*configured for chain id 31337/);
  });

  it("assertChain rejects when the RPC turns out to be Base mainnet", async () => {
    const rpc = await startChainIdRpc(8453);
    close = rpc.close;
    const client = new FleetClient({ rpcUrl: rpc.url, chainId: 31337, addresses: ADDRESSES });
    await expect(client.assertChain()).rejects.toThrow(/reports chain id 8453/);
  });
});
