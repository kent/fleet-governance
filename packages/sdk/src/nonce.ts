import { createPublicClient, http } from "viem";
import type { Address, Hex, PublicClient } from "viem";

/** One nonce this manager has reserved for an account, and what became of it. `action` is a
 *  free-form status label: `"reserved"` (allocated, not yet sent), `"sent"` (a transaction hash
 *  was committed), or `"released"` (freed back up for reuse, so it never becomes a permanent gap
 *  in the account's nonce sequence). */
export type PendingNonce = { nonce: number; txHash: Hex | null; action: string };

export type NonceAccountState = { next: number; pending: PendingNonce[] };

/** Where `NonceManager` persists reservations. `MemoryNonceStore` below is the in-process
 *  implementation this task ships; a durable `PgNonceStore` is Task 6's job. */
export interface NonceStore {
  get(account: Address): Promise<NonceAccountState>;
  set(account: Address, state: NonceAccountState): Promise<void>;
}

export type NonceReservation = {
  nonce: number;
  /** Frees the reservation without ever sending a transaction for it. Synchronous by design (a
   *  caller that decides not to send should not have to await cleanup); the underlying store
   *  write is still serialized behind every other operation on this account, so a `reserve()`
   *  that follows it always sees the release. */
  release(): void;
  /** Records that `nonce` was actually broadcast as `txHash`. Idempotent with `release()`: only
   *  the first of the two to run has any effect. */
  commit(txHash: Hex): Promise<void>;
};

/** In-memory `NonceStore`, keyed by lowercased account address. Lives only as long as the
 *  process; correct as long as one `NonceManager` per account is the only writer, which is what
 *  this task needs. A persistent, multi-writer-safe store (`PgNonceStore`) is Task 6. */
export class MemoryNonceStore implements NonceStore {
  private readonly accounts = new Map<string, NonceAccountState>();

  async get(account: Address): Promise<NonceAccountState> {
    const state = this.accounts.get(account.toLowerCase());
    if (!state) return { next: 0, pending: [] };
    return { next: state.next, pending: state.pending.map((p) => ({ ...p })) };
  }

  async set(account: Address, state: NonceAccountState): Promise<void> {
    this.accounts.set(account.toLowerCase(), { next: state.next, pending: state.pending.map((p) => ({ ...p })) });
  }
}

/**
 * Hands out nonces for accounts that sign through this process, persisted through a
 * `NonceStore` so a restart does not forget what is in flight. `reserve` never reuses a number
 * that might still land on chain, but it does reuse one a `release()` or `reconcile()` freed, so
 * a released reservation never becomes a permanent gap that would strand every later nonce.
 *
 * Every operation for a given account is serialized through an in-process queue, so concurrent
 * `reserve()`/`commit()`/`release()`/`reconcile()` calls on the same account (e.g. two writers
 * sharing one hot wallet) never race each other within this process. Cross-process coordination
 * for the same account is the job of the store itself (`PgNonceStore`, Task 6); `MemoryNonceStore`
 * only ever lives in one process, so this in-process queue is sufficient here.
 */
export class NonceManager {
  private readonly store: NonceStore;
  private readonly publicClient: PublicClient;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly bootstrapped = new Set<string>();

  constructor(store: NonceStore, rpcUrl: string) {
    this.store = store;
    this.publicClient = createPublicClient({ transport: http(rpcUrl) });
  }

  private withLock<T>(account: Address, fn: () => Promise<T>): Promise<T> {
    const key = account.toLowerCase();
    const prior = this.locks.get(key) ?? Promise.resolve();
    const settled = prior.then(fn, fn);
    this.locks.set(
      key,
      settled.then(
        () => undefined,
        () => undefined,
      ),
    );
    return settled;
  }

  async reserve(account: Address): Promise<NonceReservation> {
    const key = account.toLowerCase();
    if (!this.bootstrapped.has(key)) {
      // First time this process has reserved for this account: seed `next` from the chain's own
      // view, so a restarted process does not hand out a nonce the account already used outside
      // this manager's tracking.
      await this.reconcile(account);
      this.bootstrapped.add(key);
    }

    const nonce = await this.withLock(account, async () => {
      const state = await this.store.get(account);
      const hole = state.pending.find((p) => p.action === "released");
      if (hole) {
        const pending = state.pending.map((p) =>
          p.nonce === hole.nonce ? { nonce: p.nonce, txHash: null, action: "reserved" } : p,
        );
        await this.store.set(account, { next: state.next, pending });
        return hole.nonce;
      }
      const pending = [...state.pending, { nonce: state.next, txHash: null, action: "reserved" }];
      await this.store.set(account, { next: state.next + 1, pending });
      return state.next;
    });

    let settled = false;

    const commit = async (txHash: Hex): Promise<void> => {
      if (settled) return;
      settled = true;
      await this.withLock(account, async () => {
        const state = await this.store.get(account);
        const pending = state.pending.map((p) => (p.nonce === nonce ? { nonce, txHash, action: "sent" } : p));
        await this.store.set(account, { next: state.next, pending });
      });
    };

    const release = (): void => {
      if (settled) return;
      settled = true;
      void this.withLock(account, async () => {
        const state = await this.store.get(account);
        const pending = state.pending.map((p) =>
          p.nonce === nonce ? { nonce, txHash: null, action: "released" } : p,
        );
        await this.store.set(account, { next: state.next, pending });
      });
    };

    return { nonce, release, commit };
  }

  /**
   * Reconciles local bookkeeping against the chain's own pending nonce count
   * (`eth_getTransactionCount(account, "pending")`). Any locally tracked nonce the chain no
   * longer knows about (it was evicted from the mempool without confirming, i.e. dropped) is
   * freed back up (`action: "released"`) instead of left as a permanent gap; any nonce the chain
   * has already accounted for (mined, or still sitting in the mempool) is dropped from local
   * tracking, since this manager no longer needs to hold it. `next` never regresses below what
   * the chain reports.
   */
  async reconcile(account: Address): Promise<void> {
    await this.withLock(account, async () => {
      const state = await this.store.get(account);
      const chainNext = await this.publicClient.getTransactionCount({ address: account, blockTag: "pending" });
      const pending = state.pending
        .filter((p) => p.nonce >= chainNext)
        .map((p): PendingNonce => ({ nonce: p.nonce, txHash: null, action: "released" }));
      const next = Math.max(state.next, chainNext);
      await this.store.set(account, { next, pending });
    });
  }
}
