import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import type { Address } from "viem";
import { MemoryJobStore, PgJobStore, PgNonceStore } from "./jobs.js";
import type { JobKey } from "./jobs.js";

const GOVERNOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const AGENT_ACCOUNT = "0xccccccccccccccccccccccccccccccccccccc1" as Address;

function makeKey(overrides: Partial<JobKey> = {}): JobKey {
  return {
    chainId: 31337,
    governor: GOVERNOR,
    proposalId: "1",
    agentAddress: AGENT_ACCOUNT,
    actionType: "vote",
    ...overrides,
  };
}

describe("MemoryJobStore", () => {
  it("claim creates a fresh job at DISCOVER with zeroed bookkeeping", async () => {
    const store = new MemoryJobStore();
    const key = makeKey();
    const job = await store.claim(key);

    expect(job).not.toBeNull();
    expect(job?.state).toBe("DISCOVER");
    expect(job?.attempts).toBe(0);
    expect(job?.vote).toBeNull();
    expect(job?.txHash).toBeNull();
  });

  it("claim is exclusive: a second claim on the same key returns null", async () => {
    const store = new MemoryJobStore();
    const key = makeKey();

    const [first, second] = await Promise.all([store.claim(key), store.claim(key)]);
    const results = [first, second];
    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it("get returns null for a key that was never claimed", async () => {
    const store = new MemoryJobStore();
    expect(await store.get(makeKey())).toBeNull();
  });

  it("update merges a patch into the existing record and bumps updatedAt", async () => {
    const store = new MemoryJobStore();
    const key = makeKey();
    const created = await store.claim(key);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await store.update(key, { state: "EVALUATE", nonce: 5 });

    const updated = await store.get(key);
    expect(updated?.state).toBe("EVALUATE");
    expect(updated?.nonce).toBe(5);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());
  });

  it("update throws for a key that was never claimed", async () => {
    const store = new MemoryJobStore();
    await expect(store.update(makeKey(), { state: "EVALUATE" })).rejects.toThrow();
  });

  it("list filters by any combination of key fields and state", async () => {
    const store = new MemoryJobStore();
    await store.claim(makeKey({ proposalId: "1" }));
    await store.claim(makeKey({ proposalId: "2" }));
    await store.update(makeKey({ proposalId: "2" }), { state: "absent" });

    const all = await store.list({});
    expect(all).toHaveLength(2);

    const absentOnly = await store.list({ state: "absent" });
    expect(absentOnly).toHaveLength(1);
    expect(absentOnly[0]?.proposalId).toBe("2");

    const byProposal = await store.list({ proposalId: "1" });
    expect(byProposal).toHaveLength(1);
  });

  it("get and list return copies, not live references to internal state", async () => {
    const store = new MemoryJobStore();
    const key = makeKey();
    await store.claim(key);
    const first = await store.get(key);
    first!.state = "voted";

    const second = await store.get(key);
    expect(second?.state).toBe("DISCOVER");
  });
});

const RUNNER_PG_URL = process.env.RUNNER_PG_URL;
const RUN_PG = Boolean(RUNNER_PG_URL);

describe.skipIf(!RUN_PG)("PgJobStore (Postgres, RUNNER_PG_URL set)", () => {
  let store: PgJobStore;
  let cleanupPool: pg.Pool;

  beforeAll(async () => {
    store = new PgJobStore(RUNNER_PG_URL!);
    await store.migrate();
    cleanupPool = new pg.Pool({ connectionString: RUNNER_PG_URL! });
  });

  beforeEach(async () => {
    // Test isolation: empty the table before every test (a separate pool from the store under
    // test, so this never depends on the store's own internals).
    await cleanupPool.query("TRUNCATE jobs");
  });

  afterAll(async () => {
    await store.close();
    await cleanupPool.end();
  });

  it("migrate() is idempotent", async () => {
    await expect(store.migrate()).resolves.toBeUndefined();
    await expect(store.migrate()).resolves.toBeUndefined();
  });

  it("claim creates a fresh row at DISCOVER", async () => {
    const key = makeKey({ proposalId: "100" });
    const job = await store.claim(key);
    expect(job?.state).toBe("DISCOVER");
    expect(job?.chainId).toBe(31337);
    expect(job?.governor).toBe(GOVERNOR.toLowerCase());
  });

  it("claim is exclusive under real concurrent inserts: exactly one of two concurrent claims wins", async () => {
    const key = makeKey({ proposalId: "101" });
    const [a, b] = await Promise.all([store.claim(key), store.claim(key)]);
    const results = [a, b];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it("update round-trips bigint, JSON, and null fields through Postgres", async () => {
    const key = makeKey({ proposalId: "102" });
    await store.claim(key);
    await store.update(key, {
      state: "READ_ANCHORED_STATE",
      inputBlockNumber: 123456789012345n,
      inputBlockHash: "0xabc",
      vote: { schema: "fleet.vote.v1", proposalId: "102", support: "FOR", rationale: "r", assumptions: ["a"], riskFlags: [] },
      usage: { promptTokens: 10, completionTokens: 20 },
      attempts: 1,
    });

    const updated = await store.get(key);
    expect(updated?.state).toBe("READ_ANCHORED_STATE");
    expect(updated?.inputBlockNumber).toBe(123456789012345n);
    expect(updated?.vote?.support).toBe("FOR");
    expect(updated?.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
    expect(updated?.attempts).toBe(1);
  });

  it("get returns null for an unknown key", async () => {
    expect(await store.get(makeKey({ proposalId: "999" }))).toBeNull();
  });

  it("list filters by state across rows", async () => {
    await store.claim(makeKey({ proposalId: "200" }));
    await store.claim(makeKey({ proposalId: "201" }));
    await store.update(makeKey({ proposalId: "201" }), { state: "voted" });

    const voted = await store.list({ state: "voted" });
    expect(voted).toHaveLength(1);
    expect(voted[0]?.proposalId).toBe("201");
  });
});

describe.skipIf(RUN_PG)("PgJobStore integration (skipped)", () => {
  it("skips cleanly without RUNNER_PG_URL", () => {
    expect(RUN_PG).toBe(false);
  });
});

describe.skipIf(!RUN_PG)("PgNonceStore (Postgres, RUNNER_PG_URL set)", () => {
  let store: PgNonceStore;
  let cleanupPool: pg.Pool;

  beforeAll(async () => {
    store = new PgNonceStore(RUNNER_PG_URL!);
    await store.migrate();
    cleanupPool = new pg.Pool({ connectionString: RUNNER_PG_URL! });
  });

  beforeEach(async () => {
    await cleanupPool.query("TRUNCATE nonces");
  });

  afterAll(async () => {
    await store.close();
    await cleanupPool.end();
  });

  it("migrate() is idempotent", async () => {
    await expect(store.migrate()).resolves.toBeUndefined();
    await expect(store.migrate()).resolves.toBeUndefined();
  });

  it("get returns the zero state for an account never seen before", async () => {
    const state = await store.get(("0x" + "01".repeat(20)) as Address);
    expect(state).toEqual({ next: 0, pending: [] });
  });

  it("set then get round-trips next and pending", async () => {
    const account = ("0x" + "02".repeat(20)) as Address;
    await store.set(account, { next: 3, pending: [{ nonce: 2, txHash: "0xdead", action: "sent" }] });

    const state = await store.get(account);
    expect(state.next).toBe(3);
    expect(state.pending).toEqual([{ nonce: 2, txHash: "0xdead", action: "sent" }]);
  });

  it("set upserts: a second set on the same account overwrites rather than duplicating", async () => {
    const account = ("0x" + "03".repeat(20)) as Address;
    await store.set(account, { next: 1, pending: [] });
    await store.set(account, { next: 2, pending: [] });

    const state = await store.get(account);
    expect(state.next).toBe(2);
  });
});

describe.skipIf(RUN_PG)("PgNonceStore integration (skipped)", () => {
  it("skips cleanly without RUNNER_PG_URL", () => {
    expect(RUN_PG).toBe(false);
  });
});
