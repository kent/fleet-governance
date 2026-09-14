import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  keeperLastActionFromLog,
  probeDaoNode,
  probeHealth,
  probeReachable,
  probeSignerBalance,
} from "./health.js";
import type { FetchProbe } from "./health.js";

const ADDR = "0x1000000000000000000000000000000000000001" as Address;

describe("probeDaoNode", () => {
  it("reports lag as chain head minus the reported block", async () => {
    const fetchProbe: FetchProbe = async () => ({ ok: true, status: 200, text: JSON.stringify({ blockNumber: 95 }) });
    const health = await probeDaoNode("http://localhost:8000", async () => 100n, fetchProbe);
    expect(health).toEqual({ ok: true, lagBlocks: 5, detail: "reports block 95, chain head 100" });
  });

  it("reports unreachable when the fetch throws, without calling getChainHead", async () => {
    const fetchProbe: FetchProbe = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    let chainHeadCalled = false;
    const health = await probeDaoNode("http://localhost:8000", async () => {
      chainHeadCalled = true;
      return 0n;
    }, fetchProbe);
    expect(health.ok).toBe(false);
    expect(health.lagBlocks).toBeNull();
    expect(health.detail).toContain("unreachable");
    expect(chainHeadCalled).toBe(false);
  });

  it("reports ok with a null lag when the response has no recognized block field", async () => {
    const fetchProbe: FetchProbe = async () => ({ ok: true, status: 200, text: JSON.stringify({ status: "ok" }) });
    const health = await probeDaoNode("http://localhost:8000", async () => 100n, fetchProbe);
    expect(health).toEqual({ ok: true, lagBlocks: null, detail: expect.stringContaining("no recognized block field") });
  });

  it("reports a non-2xx response as not ok", async () => {
    const fetchProbe: FetchProbe = async () => ({ ok: false, status: 503, text: "" });
    const health = await probeDaoNode("http://localhost:8000", async () => 100n, fetchProbe);
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("503");
  });
});

describe("probeReachable", () => {
  it("is ok for a 2xx response", async () => {
    const fetchProbe: FetchProbe = async () => ({ ok: true, status: 200, text: "" });
    expect(await probeReachable("http://localhost:8001/health", fetchProbe)).toEqual({ ok: true, detail: "http://localhost:8001/health -> HTTP 200" });
  });

  it("is unreachable when the fetch throws", async () => {
    const fetchProbe: FetchProbe = async () => {
      throw new Error("timeout");
    };
    const result = await probeReachable("http://localhost:3000", fetchProbe);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("timeout");
  });
});

describe("keeperLastActionFromLog", () => {
  it("returns the last line mentioning keeper, case-insensitively", () => {
    const log = ["2026-09-14 boot", "2026-09-14 Keeper recorded decision 1", "2026-09-14 worker voted", "2026-09-14 keeper recorded decision 2"].join(
      "\n",
    );
    expect(keeperLastActionFromLog(log)).toBe("2026-09-14 keeper recorded decision 2");
  });

  it("returns null when the log has no keeper line", () => {
    expect(keeperLastActionFromLog("2026-09-14 boot\n2026-09-14 worker voted\n")).toBeNull();
  });
});

describe("probeSignerBalance", () => {
  it("reports the balance as a decimal string", async () => {
    const result = await probeSignerBalance("guardian", ADDR, async () => 123456789n);
    expect(result).toEqual({ label: "guardian", address: ADDR, balanceWei: "123456789", ok: true });
  });

  it("reports ok: false when the balance read fails", async () => {
    const result = await probeSignerBalance("guardian", ADDR, async () => {
      throw new Error("rpc down");
    });
    expect(result).toEqual({ label: "guardian", address: ADDR, balanceWei: null, ok: false });
  });
});

describe("probeHealth", () => {
  it("assembles every probe, skipping Agora Next when its URL is unset", async () => {
    const fetchProbe: FetchProbe = async (url) => {
      if (url.includes("/v1/progress")) return { ok: true, status: 200, text: JSON.stringify({ blockNumber: 10 }) };
      if (url.includes("/health")) return { ok: true, status: 200, text: "" };
      return { ok: false, status: 404, text: "" };
    };
    const health = await probeHealth({
      daoNodeUrl: "http://localhost:8000",
      cplsUrl: "http://localhost:8001",
      agoraNextUrl: null,
      getChainHead: async () => 12n,
      getBalanceWei: async () => 1n,
      signers: [{ label: "guardian", address: ADDR }],
      logText: "keeper recorded decision 1\n",
      fetchProbe,
    });
    expect(health.daoNode).toEqual({ ok: true, lagBlocks: 2, detail: "reports block 10, chain head 12" });
    expect(health.cpls.ok).toBe(true);
    expect(health.agoraNext).toEqual({ ok: false, detail: "not configured (display.agoraNextBaseUrl unset)" });
    expect(health.keeperLastAction).toBe("keeper recorded decision 1");
    expect(health.signerBalances).toEqual([{ label: "guardian", address: ADDR, balanceWei: "1", ok: true }]);
  });
});
