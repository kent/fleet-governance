import { expect, it } from "vitest";
import { boundedLogRequest, incrementalLogRequest } from "./log-transport.js";

it("clips a genesis scan to deployment and keeps address/topic filters on each ten-block page", async () => {
  const requests: { method: string; params?: readonly unknown[] }[] = [];
  const read = boundedLogRequest(async request => { requests.push(request); return request.method === "eth_blockNumber" ? "0x7c" : [request.params?.[0]]; }, 100n);
  const result = await read({ method: "eth_getLogs", params: [{ address: "0xabc", topics: ["0xdef"], fromBlock: "0x0", toBlock: "latest" }] });
  expect(result).toEqual([
    { address: "0xabc", topics: ["0xdef"], fromBlock: "0x64", toBlock: "0x6d" },
    { address: "0xabc", topics: ["0xdef"], fromBlock: "0x6e", toBlock: "0x77" },
    { address: "0xabc", topics: ["0xdef"], fromBlock: "0x78", toBlock: "0x7c" },
  ]);
  expect(requests).toHaveLength(4);
});

function chain() {
  let height = 124n;
  let fork = 0;
  const requests: { method: string; params?: readonly unknown[] }[] = [];
  const rpc = async (request: { method: string; params?: readonly unknown[] }) => {
    requests.push(request);
    if (request.method === "eth_getBlockByNumber") {
      const tag = request.params?.[0];
      const number = tag === "latest" ? height : BigInt(tag as string);
      return { number: `0x${number.toString(16)}`, hash: `0x${(number + BigInt(fork) * 1000n).toString(16).padStart(64, "0")}` };
    }
    if (request.method === "eth_getLogs") return [{ filter: request.params?.[0], fork }];
    return request;
  };
  return { rpc, requests, read: incrementalLogRequest(rpc, boundedLogRequest(rpc, 100n)), advance: () => { height += 2n; }, reorg: () => { fork++; }, rewind: () => { height = 102n; } };
}
const historyRequest = { method: "eth_getLogs", params: [{ address: "0xabc", topics: ["0xdef"], fromBlock: "0x0", toBlock: "latest" }] };

it("reuses canonical history and scans only new blocks, coalescing simultaneous reads", async () => {
  const c = chain();
  const [first, concurrent] = await Promise.all([c.read(historyRequest), c.read(historyRequest)]);
  expect(first).toEqual(concurrent);
  expect(c.requests.filter(r => r.method === "eth_getLogs")).toHaveLength(3);
  expect(await c.read(historyRequest)).toEqual(first);
  expect(c.requests.filter(r => r.method === "eth_getLogs")).toHaveLength(3);
  c.advance();
  const result = await c.read(historyRequest) as unknown[];
  expect(result).toHaveLength(4);
  expect(c.requests.filter(r => r.method === "eth_getLogs").at(-1)?.params).toEqual([{ address: "0xabc", topics: ["0xdef"], fromBlock: "0x7d", toBlock: "0x7e" }]);
});

it("discards orphaned history on same-height reorg and on head regression", async () => {
  const c = chain();
  await c.read(historyRequest);
  c.reorg();
  const rebuilt = await c.read(historyRequest) as { fork: number }[];
  expect(rebuilt).toHaveLength(3);
  expect(rebuilt.every(log => log.fork === 1)).toBe(true);
  c.rewind();
  expect(await c.read(historyRequest)).toHaveLength(1);
  expect(c.requests.filter(r => r.method === "eth_getLogs")).toHaveLength(7);
});

it("validates the old tip when head advances and keeps address/topic filters separate", async () => {
  const c = chain();
  await c.read(historyRequest);
  c.advance(); c.reorg();
  expect(await c.read(historyRequest)).toHaveLength(3);
  expect(c.requests.filter(r => r.method === "eth_getLogs")).toHaveLength(6);
  await c.read({ ...historyRequest, params: [{ ...historyRequest.params[0], topics: ["0xother"] }] });
  expect(c.requests.filter(r => r.method === "eth_getLogs")).toHaveLength(9);
});

it("does not cache permission reads, writes or block hash queries", async () => {
  const c = chain();
  for (const request of [
    { method: "eth_call", params: [{ to: "0xabc", data: "0xdef" }, "latest"] },
    { method: "eth_sendRawTransaction", params: ["0xabc"] },
    { method: "eth_getLogs", params: [{ blockHash: "0xabc" }] },
  ]) { await c.read(request); await c.read(request); }
  expect(c.requests).toHaveLength(6);
  expect(c.requests.some(r => r.method === "eth_getBlockByNumber")).toBe(false);
});

it("shares the growing history with explicit block captures without leaking later logs into earlier reads", async () => {
  const c = chain();
  await c.read(historyRequest);
  c.advance();
  const at = (end: string) => c.read({ ...historyRequest, params: [{ ...historyRequest.params[0], toBlock: end }] });
  expect(await at("0x7e")).toHaveLength(4);
  expect(c.requests.filter(r => r.method === "eth_getLogs")).toHaveLength(4);
  expect(await at("0x66")).toHaveLength(1);
  expect(c.requests.filter(r => r.method === "eth_getLogs").at(-1)?.params).toEqual([{ ...historyRequest.params[0], fromBlock: "0x64", toBlock: "0x66" }]);
});

it("fails on invalid headers, failed pages and a reorg during the scan; retries do not use failed results", async () => {
  await expect(incrementalLogRequest(async () => null, async () => [])(historyRequest)).rejects.toThrow("invalid canonical block header");
  const c = chain();
  let fail = true;
  const read = incrementalLogRequest(c.rpc, async request => {
    if (fail) { fail = false; throw new Error("rate limited"); }
    return boundedLogRequest(c.rpc, 100n)(request);
  });
  await expect(read(historyRequest)).rejects.toThrow("rate limited");
  expect(await read(historyRequest)).toHaveLength(3);
  const reorgingRead = incrementalLogRequest(c.rpc, async () => { c.reorg(); return []; });
  await expect(reorgingRead(historyRequest)).rejects.toThrow("reorganized during event scan");
});
it("does not alter block-hash filters or signing requests, and never hides a failed page", async () => {
  const request = { method: "eth_getLogs", params: [{ blockHash: "0xabc" }] };
  expect(await boundedLogRequest(async input => input, 1n)(request)).toEqual(request);
  const transaction = { method: "eth_sendRawTransaction", params: ["0xabc"] };
  expect(await boundedLogRequest(async input => input, 1n)(transaction)).toEqual(transaction);
  await expect(boundedLogRequest(async () => { throw new Error("unavailable"); }, 1n)({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x10" }] })).rejects.toThrow("unavailable");
});
