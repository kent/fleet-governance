import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { MemoryNonceStore, NonceManager } from "./nonce.js";

const ACCOUNT = `0x${"11".repeat(20)}` as Address;
const OTHER_ACCOUNT = `0x${"22".repeat(20)}` as Address;

/** A tiny local JSON-RPC HTTP server that answers `eth_getTransactionCount` from a mutable
 *  in-test value, so `NonceManager`'s `rpcUrl: string` constructor argument can point at a fake
 *  transport without needing a live chain. Every other method fails loudly, so a test only
 *  passes if the code under test calls exactly the RPC methods it is expected to. */
function startFakeRpc(pendingCountByAccount: Map<string, number>): Promise<{ url: string; close: () => Promise<void> }> {
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
        if (body.method === "eth_getTransactionCount") {
          const account = String((body.params ?? [])[0]).toLowerCase();
          const count = pendingCountByAccount.get(account) ?? 0;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${count.toString(16)}` }));
          return;
        }
        throw new Error(`unstubbed RPC method in nonce test fake transport: ${body.method}`);
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
        );
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
      });
    });
  });
}

describe("NonceManager", () => {
  let close: () => Promise<void>;
  let url: string;
  let pendingCount: Map<string, number>;

  beforeEach(async () => {
    pendingCount = new Map([[ACCOUNT.toLowerCase(), 0]]);
    const fake = await startFakeRpc(pendingCount);
    url = fake.url;
    close = fake.close;
  });

  afterEach(async () => {
    await close();
  });

  it("reserve hands out sequential nonces seeded from the chain's pending count", async () => {
    pendingCount.set(ACCOUNT.toLowerCase(), 7);
    const manager = new NonceManager(new MemoryNonceStore(), url);

    const first = await manager.reserve(ACCOUNT);
    const second = await manager.reserve(ACCOUNT);
    const third = await manager.reserve(ACCOUNT);

    expect(first.nonce).toBe(7);
    expect(second.nonce).toBe(8);
    expect(third.nonce).toBe(9);
  });

  it("commit records the transaction hash without changing what the next reserve returns", async () => {
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    const first = await manager.reserve(ACCOUNT);
    const txHash = `0x${"aa".repeat(32)}` as Hex;
    await first.commit(txHash);

    const state = await store.get(ACCOUNT);
    expect(state.pending).toEqual([{ nonce: 0, txHash, action: "sent" }]);

    const second = await manager.reserve(ACCOUNT);
    expect(second.nonce).toBe(1);
  });

  it("release frees a reservation so the next reserve reuses the same nonce", async () => {
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    const first = await manager.reserve(ACCOUNT);
    expect(first.nonce).toBe(0);
    first.release();

    // release() is synchronous but the underlying store write is queued behind this account's
    // lock; the next reserve() call is queued behind the same lock, so it still observes it.
    const second = await manager.reserve(ACCOUNT);
    expect(second.nonce).toBe(0);
  });

  it("commit after release is a no-op: the nonce stays released, not sent", async () => {
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    const reservation = await manager.reserve(ACCOUNT);
    reservation.release();
    await reservation.commit(`0x${"bb".repeat(32)}` as Hex);

    // release() is synchronous but queues its store write behind this account's lock; the next
    // reserve() call is queued behind the same lock, so awaiting it also waits for the release
    // (and the no-op commit) to have landed. If commit() had overwritten the released entry back
    // to "sent" instead of no-op'ing, this would return nonce 1, not the reused nonce 0.
    const next = await manager.reserve(ACCOUNT);
    expect(next.nonce).toBe(0);

    const state = await store.get(ACCOUNT);
    expect(state.pending).toEqual([{ nonce: 0, txHash: null, action: "reserved" }]);
  });

  it("release after commit is a no-op: the nonce stays sent, not released", async () => {
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    const reservation = await manager.reserve(ACCOUNT);
    const txHash = `0x${"ff".repeat(32)}` as Hex;
    await reservation.commit(txHash);
    reservation.release();

    // Same flush technique as above: wait behind the same per-account lock the no-op release()
    // queued onto.
    const next = await manager.reserve(ACCOUNT);
    expect(next.nonce).toBe(1);

    const state = await store.get(ACCOUNT);
    expect(state.pending).toEqual(
      expect.arrayContaining([{ nonce: 0, txHash, action: "sent" }]),
    );
  });

  it("reserve does not reuse the nonce of a reservation that was committed, not released", async () => {
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    const first = await manager.reserve(ACCOUNT);
    await first.commit(`0x${"cc".repeat(32)}` as Hex);

    const second = await manager.reserve(ACCOUNT);
    expect(second.nonce).toBe(1);
  });

  it("reconcile frees a committed nonce the chain no longer knows about (a dropped transaction)", async () => {
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    const first = await manager.reserve(ACCOUNT); // bootstrap reconcile sees pending count 0 -> nonce 0
    expect(first.nonce).toBe(0);
    await first.commit(`0x${"dd".repeat(32)}` as Hex);

    const second = await manager.reserve(ACCOUNT);
    expect(second.nonce).toBe(1);
    await second.commit(`0x${"ee".repeat(32)}` as Hex);

    // Neither transaction ever actually reached the mempool (dropped): the chain still reports
    // pending count 0.
    pendingCount.set(ACCOUNT.toLowerCase(), 0);
    await manager.reconcile(ACCOUNT);

    const state = await store.get(ACCOUNT);
    expect(state.pending).toEqual(
      expect.arrayContaining([
        { nonce: 0, txHash: null, action: "released" },
        { nonce: 1, txHash: null, action: "released" },
      ]),
    );

    // The freed nonces are reused, lowest first, rather than skipped.
    const third = await manager.reserve(ACCOUNT);
    const fourth = await manager.reserve(ACCOUNT);
    expect([third.nonce, fourth.nonce].sort()).toEqual([0, 1]);
  });

  it("reconcile does not release a reservation that has not been sent yet, so its nonce is never handed out twice", async () => {
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    const first = await manager.reserve(ACCOUNT); // bootstrap reconcile sees pending count 0 -> nonce 0
    expect(first.nonce).toBe(0);

    // The chain still reports pending count 0: nothing has been broadcast for this reservation
    // yet (it has not been committed). A naive reconcile that releases everything >= chainNext
    // would free nonce 0 here even though `first` can still legitimately commit it.
    await manager.reconcile(ACCOUNT);

    const second = await manager.reserve(ACCOUNT);
    expect(second.nonce).toBe(1);

    // The original reservation is untouched by the reconcile and still commits successfully.
    await expect(first.commit(`0x${"ab".repeat(32)}` as Hex)).resolves.toBeUndefined();
    const state = await store.get(ACCOUNT);
    expect(state.pending).toEqual(
      expect.arrayContaining([
        { nonce: 0, txHash: `0x${"ab".repeat(32)}`, action: "sent" },
        { nonce: 1, txHash: null, action: "reserved" },
      ]),
    );
  });

  it("five concurrent reserve() calls on one account yield five distinct nonces", async () => {
    const manager = new NonceManager(new MemoryNonceStore(), url);

    const reservations = await Promise.all(Array.from({ length: 5 }, () => manager.reserve(ACCOUNT)));

    const nonces = reservations.map((r) => r.nonce).sort((a, b) => a - b);
    expect(nonces).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(nonces).size).toBe(5);
  });

  it("reconcile advances next when the chain reports a higher pending count than local state", async () => {
    pendingCount.set(ACCOUNT.toLowerCase(), 3);
    const store = new MemoryNonceStore();
    const manager = new NonceManager(store, url);

    // Bootstraps to next = 3.
    const first = await manager.reserve(ACCOUNT);
    expect(first.nonce).toBe(3);

    // Some other process sent transactions 4 and 5 from this account outside our tracking.
    pendingCount.set(ACCOUNT.toLowerCase(), 6);
    await manager.reconcile(ACCOUNT);

    const second = await manager.reserve(ACCOUNT);
    expect(second.nonce).toBe(6);
  });

  it("tracks each account independently", async () => {
    pendingCount.set(ACCOUNT.toLowerCase(), 2);
    pendingCount.set(OTHER_ACCOUNT.toLowerCase(), 9);
    const manager = new NonceManager(new MemoryNonceStore(), url);

    const a = await manager.reserve(ACCOUNT);
    const b = await manager.reserve(OTHER_ACCOUNT);

    expect(a.nonce).toBe(2);
    expect(b.nonce).toBe(9);
  });
});

describe("MemoryNonceStore", () => {
  it("returns an empty default state for an account it has never seen", async () => {
    const store = new MemoryNonceStore();
    await expect(store.get(ACCOUNT)).resolves.toEqual({ next: 0, pending: [] });
  });

  it("get returns a defensive copy that later mutation of the store does not affect", async () => {
    const store = new MemoryNonceStore();
    await store.set(ACCOUNT, { next: 1, pending: [{ nonce: 0, txHash: null, action: "reserved" }] });
    const read = await store.get(ACCOUNT);
    read.pending.push({ nonce: 99, txHash: null, action: "reserved" });

    const readAgain = await store.get(ACCOUNT);
    expect(readAgain.pending).toEqual([{ nonce: 0, txHash: null, action: "reserved" }]);
  });
});
