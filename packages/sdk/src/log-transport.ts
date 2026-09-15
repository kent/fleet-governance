import { custom, http, type Transport } from "viem";

type RpcRequest = { method: string; params?: readonly unknown[] };
type Rpc = (request: RpcRequest) => Promise<unknown>;
const hex = (value: bigint) => `0x${value.toString(16)}`;
export const testnetHttpOptions = { retryCount: 5, retryDelay: 1000 } as const;

type CachedLogs = { to: bigint; hash: string; logs: unknown[] };
type LogCache = { entries: Map<string, CachedLogs>; pending: Map<string, Promise<unknown>> };
const endpointCaches = new Map<string, LogCache>();

/** Reuse only canonical event history. Permission reads and writes always reach the RPC. */
export function incrementalLogRequest(rpc: Rpc, paged: Rpc, cache: LogCache = { entries: new Map(), pending: new Map() }): Rpc {
  const header = async (tag: string) => {
    const block = await rpc({ method: "eth_getBlockByNumber", params: [tag, false] }) as { number?: string; hash?: string } | null;
    if (!block?.number || !/^0x[0-9a-f]+$/i.test(block.number) || !block.hash || !/^0x[0-9a-f]{64}$/i.test(block.hash)) {
      throw new Error("RPC returned an invalid canonical block header.");
    }
    if (tag !== "latest" && BigInt(block.number) !== BigInt(tag)) throw new Error("RPC returned the wrong block header.");
    return { number: BigInt(block.number), hash: block.hash.toLowerCase() };
  };
  return async request => {
    const filter = request.params?.[0] as Record<string, unknown> | undefined;
    // A moving start, a block hash, or a pending/finality tag has different semantics.
    if (request.method !== "eth_getLogs" || !filter || filter.blockHash ||
        !(filter.toBlock === undefined || filter.toBlock === "latest" || (typeof filter.toBlock === "string" && /^0x[0-9a-f]+$/i.test(filter.toBlock))) ||
        !(filter.fromBlock === "earliest" || (typeof filter.fromBlock === "string" && /^0x[0-9a-f]+$/i.test(filter.fromBlock)))) return paged(request);
    const key = JSON.stringify(Object.fromEntries(Object.entries(filter).filter(([name]) => name !== "toBlock").sort(([a], [b]) => a.localeCompare(b))));
    const requestKey = `${key}:${filter.toBlock ?? "latest"}`;
    const pending = cache.pending.get(requestKey);
    if (pending) return pending;
    const scan = (async () => {
      const head = await header(typeof filter.toBlock === "string" ? filter.toBlock : "latest");
      const previous = cache.entries.get(key);
      let prefix: CachedLogs | undefined;
      if (previous && previous.to <= head.number) {
        const tip = previous.to === head.number ? head : await header(hex(previous.to));
        if (tip.hash === previous.hash) prefix = previous;
      }
      if (prefix?.to === head.number) return [...prefix.logs];
      // Invalidate before requesting pages so a failed/reorganized scan cannot bless stale data.
      cache.entries.delete(key);
      const next = await paged({ method: "eth_getLogs", params: [{ ...filter, fromBlock: prefix ? hex(prefix.to + 1n) : filter.fromBlock, toBlock: hex(head.number) }] });
      if (!Array.isArray(next)) throw new Error("RPC returned an invalid event page.");
      if ((await header(hex(head.number))).hash !== head.hash) throw new Error("Chain reorganized during event scan; retry from a canonical head.");
      const logs = [...(prefix?.logs ?? []), ...next];
      if (logs.length <= 50_000) {
        if (cache.entries.size >= 64) cache.entries.delete(cache.entries.keys().next().value!);
        cache.entries.set(key, { to: head.number, hash: head.hash, logs });
      }
      return [...logs];
    })();
    cache.pending.set(requestKey, scan);
    try { return await scan; } finally { cache.pending.delete(requestKey); }
  };
}

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
  const key = `${url}:${deploymentBlock}`;
  let cache = endpointCaches.get(key);
  if (!cache) {
    if (endpointCaches.size >= 16) endpointCaches.delete(endpointCaches.keys().next().value!);
    cache = { entries: new Map(), pending: new Map() };
    endpointCaches.set(key, cache);
  }
  return options => {
    const upstream = http(url, testnetHttpOptions)(options);
    const rpc: Rpc = request => upstream.request(request as Parameters<typeof upstream.request>[0]);
    return custom({ request: incrementalLogRequest(rpc, boundedLogRequest(rpc, deploymentBlock), cache) }, { retryCount: 0 })(options);
  };
}
