import { expect, it } from "vitest";
import { boundedLogRequest } from "./log-transport.js";

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
it("does not alter block-hash filters or signing requests, and never hides a failed page", async () => {
  const request = { method: "eth_getLogs", params: [{ blockHash: "0xabc" }] };
  expect(await boundedLogRequest(async input => input, 1n)(request)).toEqual(request);
  const transaction = { method: "eth_sendRawTransaction", params: ["0xabc"] };
  expect(await boundedLogRequest(async input => input, 1n)(transaction)).toEqual(transaction);
  await expect(boundedLogRequest(async () => { throw new Error("unavailable"); }, 1n)({ method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x10" }] })).rejects.toThrow("unavailable");
});
