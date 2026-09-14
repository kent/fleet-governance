import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { formatPreflightReport, runPreflight } from "./preflight.js";
import type { PreflightDeps } from "./preflight.js";

const AGENT: Address = "0x70997970c51812dc3a010c7d01b50e0d17dc79c";

function fakeDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    hasBinary: () => true,
    getChainId: async () => 31337,
    getBalanceWei: async () => 1_000_000_000_000_000_000n,
    fetchUrl: async () => ({ ok: true, status: 200 }),
    ...overrides,
  };
}

describe("runPreflight (task 8 finding 2)", () => {
  it("passes when every tool is present, the chain is reachable, and every key has a balance", async () => {
    const report = await runPreflight({
      deps: fakeDeps(),
      readSideEnabled: false,
      keyAddresses: [{ label: "deployer", address: AGENT }],
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(["tool:forge", "tool:anvil", "tool:cast", "chain_id", "balance:deployer"]);
  });

  it("checks docker only when the read side is enabled", async () => {
    const withoutReadSide = await runPreflight({ deps: fakeDeps(), readSideEnabled: false, keyAddresses: [] });
    expect(withoutReadSide.checks.some((c) => c.name === "tool:docker")).toBe(false);

    const withReadSide = await runPreflight({
      deps: fakeDeps(),
      readSideEnabled: true,
      keyAddresses: [],
      readSide: { daoNodeUrl: "http://localhost:8000", cplsUrl: "http://localhost:8001", agoraNextUrl: "http://localhost:3000" },
      bucketCheckUrl: "http://localhost:4443/storage/v1/b/fleet-archive-dev/o",
    });
    expect(withReadSide.checks.some((c) => c.name === "tool:docker")).toBe(true);
  });

  it("fails when a required tool is missing from PATH", async () => {
    const report = await runPreflight({
      deps: fakeDeps({ hasBinary: (name) => name !== "anvil" }),
      readSideEnabled: false,
      keyAddresses: [],
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "tool:anvil")?.ok).toBe(false);
  });

  it("fails when the chain is unreachable", async () => {
    const report = await runPreflight({
      deps: fakeDeps({
        getChainId: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
      readSideEnabled: false,
      keyAddresses: [],
    });
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.name === "chain_id");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("ECONNREFUSED");
  });

  it("fails when the reachable chain id does not match an existing manifest's chainId", async () => {
    const report = await runPreflight({
      deps: fakeDeps({ getChainId: async () => 1 }),
      readSideEnabled: false,
      keyAddresses: [],
      existingManifestChainId: 31337,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "chain_id")?.ok).toBe(false);
  });

  it("checks a balance per key and fails any key with a zero balance", async () => {
    const balances: Record<string, bigint> = {
      "0xdeployer00000000000000000000000000000000": 1n,
      "0xoperator00000000000000000000000000000000": 0n,
    };
    const report = await runPreflight({
      deps: fakeDeps({ getBalanceWei: async (addr) => balances[addr.toLowerCase()] ?? 0n }),
      readSideEnabled: false,
      keyAddresses: [
        { label: "deployer", address: "0xdeployer00000000000000000000000000000000" as Address },
        { label: "operator", address: "0xoperator00000000000000000000000000000000" as Address },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "balance:deployer")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "balance:operator")?.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "balance:operator")?.detail).toContain("zero balance");
  });

  it("checks read-side container health endpoints and the bucket only when the read side is enabled", async () => {
    const calledUrls: string[] = [];
    const report = await runPreflight({
      deps: fakeDeps({
        fetchUrl: async (url) => {
          calledUrls.push(url);
          const isCpls = url.includes(":8001");
          return { ok: !isCpls, status: isCpls ? 503 : 200 };
        },
      }),
      readSideEnabled: true,
      keyAddresses: [],
      readSide: { daoNodeUrl: "http://localhost:8000", cplsUrl: "http://localhost:8001", agoraNextUrl: "http://localhost:3000" },
      bucketCheckUrl: "http://localhost:4443/storage/v1/b/fleet-archive-dev/o",
    });
    expect(calledUrls).toEqual([
      "http://localhost:8000/v1/progress",
      "http://localhost:8001/health",
      "http://localhost:3000/proposals",
      "http://localhost:4443/storage/v1/b/fleet-archive-dev/o",
    ]);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "cpls:/health")?.ok).toBe(false);
    expect(report.checks.find((c) => c.name === "dao_node:/v1/progress")?.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "bucket_access")?.ok).toBe(true);
  });

  it("fails bucket_access when the read side is enabled but no bucketCheckUrl was given", async () => {
    const report = await runPreflight({
      deps: fakeDeps(),
      readSideEnabled: true,
      keyAddresses: [],
      readSide: { daoNodeUrl: "http://localhost:8000", cplsUrl: "http://localhost:8001", agoraNextUrl: "http://localhost:3000" },
    });
    expect(report.checks.find((c) => c.name === "bucket_access")?.ok).toBe(false);
  });

  it("runs every check rather than stopping at the first failure", async () => {
    const report = await runPreflight({
      deps: fakeDeps({ hasBinary: () => false, getChainId: async () => { throw new Error("down"); }, getBalanceWei: async () => 0n }),
      readSideEnabled: false,
      keyAddresses: [{ label: "deployer", address: AGENT }],
    });
    expect(report.checks.length).toBe(5);
    expect(report.checks.every((c) => !c.ok)).toBe(true);
  });
});

describe("formatPreflightReport", () => {
  it("renders one [ok]/[FAIL] line per check", async () => {
    const report = await runPreflight({ deps: fakeDeps(), readSideEnabled: false, keyAddresses: [{ label: "deployer", address: AGENT }] });
    const text = formatPreflightReport(report);
    const lines = text.split("\n");
    expect(lines.length).toBe(report.checks.length);
    expect(lines.every((l) => l.startsWith("[ok]"))).toBe(true);
  });
});
