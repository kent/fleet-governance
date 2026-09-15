import { custom, http, type Transport } from "viem";

type RpcRequest = { method: string; params?: readonly unknown[] };
type Rpc = (request: RpcRequest) => Promise<unknown>;
const hex = (value: bigint) => `0x${value.toString(16)}`;

/** Keep every filter intact while splitting public-testnet log reads into provider-sized pages. */
export function boundedLogRequest(rpc: Rpc, deploymentBlock: bigint, span = 10n): Rpc {
  if (deploymentBlock < 0n || span < 1n) throw new Error("Invalid log range configuration.");
  return async request => {
    if (request.method !== "eth_getLogs") return rpc(request);
    const filter = request.params?.[0] as Record<string, unknown> | undefined;
    if (!filter || filter.blockHash) return rpc(request);
    const resolve = async (value: unknown, fallback: bigint) => {
      if (value === "earliest") return 0n;
      if (value === "latest" || value === undefined) return BigInt(await rpc({ method: "eth_blockNumber" }) as string);
      if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value);
      if (value === "safe" || value === "finalized" || value === "pending") {
        const block = await rpc({ method: "eth_getBlockByNumber", params: [value, false] }) as { number?: string } | null;
        if (block?.number) return BigInt(block.number);
      }
      throw new Error("Unsupported log block reference.");
    };
    const start = await resolve(filter.fromBlock, deploymentBlock);
    const from = start < deploymentBlock ? deploymentBlock : start;
    const to = await resolve(filter.toBlock, from);
    if (to < from) return [];
    if ((to - from) / span > 10000n) throw new Error("Log scan exceeds the supported run history. Set the deployment block.");
    const logs: unknown[] = [];
    for (let first = from; first <= to; first += span) {
      const last = first + span - 1n < to ? first + span - 1n : to;
      const page = await rpc({ method: "eth_getLogs", params: [{ ...filter, fromBlock: hex(first), toBlock: hex(last) }] });
      if (!Array.isArray(page)) throw new Error("RPC returned an invalid event page.");
      logs.push(...page);
    }
    return logs;
  };
}

export function logBoundedHttp(url: string, deploymentBlock: bigint): Transport {
  return options => {
    const upstream = http(url)(options);
    const rpc: Rpc = request => upstream.request(request as Parameters<typeof upstream.request>[0]);
    return custom({ request: boundedLogRequest(rpc, deploymentBlock) }, { retryCount: 0 })(options);
  };
}
