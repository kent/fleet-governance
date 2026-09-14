import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvError, loadManifest, parseKeeperEnv } from "./env.js";

function fakeAddress(i: number): string {
  return "0x" + i.toString(16).padStart(40, "0");
}

function fakeHex32(i: number): string {
  return "0x" + i.toString(16).padStart(64, "0");
}

const VALID_MANIFEST = {
  schema: "fleet.manifest.v1",
  chainId: 31337,
  deploymentBlock: 3,
  deploymentTimestamp: 1700000000,
  deployer: fakeAddress(1),
  addresses: {
    registry: fakeAddress(2),
    token: fakeAddress(3),
    timelock: fakeAddress(4),
    ledger: fakeAddress(5),
    hook: fakeAddress(6),
    governor: fakeAddress(7),
  },
  hookSalt: fakeHex32(0x1e9db),
  members: [fakeAddress(10), fakeAddress(11)],
  operator: fakeAddress(15),
  guardian: fakeAddress(16),
  tokenName: "Fleet Vote",
  tokenSymbol: "FLEET",
  configPath: "deployments/configs/local-5.json",
  params: {
    votingDelay: 15,
    votingPeriod: 120,
    proposalThreshold: "1000000000000000000",
    quorumNumerator: 6000,
    timelockDelay: 30,
    maxTaskLifetime: 7200,
  },
  countingRule: "for-only-quorum",
  hookPermissionMask: "0x22C0",
  configHash: fakeHex32(1),
  compiler: { solc: "0.8.26", evm: "cancun", optimizerRuns: 200 },
  pins: { agoraGovernor: "v1.0.0", openzeppelin: "v5.0.0" },
  codeHashes: {
    registry: fakeHex32(2),
    token: fakeHex32(3),
    timelock: fakeHex32(4),
    ledger: fakeHex32(5),
    hook: fakeHex32(6),
    governor: fakeHex32(7),
  },
};

const KEY = ("0x" + "11".repeat(32)) as `0x${string}`;

const BASE_ENV = {
  FLEET_MANIFEST: "/tmp/does-not-matter.json",
  FLEET_RPC_HTTP: "http://127.0.0.1:8545",
  FLEET_KEEPER_KEY: KEY,
};

describe("parseKeeperEnv", () => {
  it("parses a minimal valid environment with defaults", () => {
    const env = parseKeeperEnv(BASE_ENV);
    expect(env).toEqual({
      manifestPath: "/tmp/does-not-matter.json",
      rpcHttpUrl: "http://127.0.0.1:8545",
      pgUrl: undefined,
      pollMs: 2000,
      logLevel: "info",
      keeperKey: KEY,
    });
  });

  it("reads RUNNER_PG_URL, FLEET_POLL_MS, and LOG_LEVEL when set", () => {
    const env = parseKeeperEnv({
      ...BASE_ENV,
      RUNNER_PG_URL: "postgres://localhost/fleet",
      FLEET_POLL_MS: "500",
      LOG_LEVEL: "debug",
    });
    expect(env.pgUrl).toBe("postgres://localhost/fleet");
    expect(env.pollMs).toBe(500);
    expect(env.logLevel).toBe("debug");
  });

  it("throws EnvError when FLEET_MANIFEST is missing", () => {
    const { FLEET_MANIFEST: _drop, ...rest } = BASE_ENV;
    expect(() => parseKeeperEnv(rest)).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_RPC_HTTP is missing", () => {
    const { FLEET_RPC_HTTP: _drop, ...rest } = BASE_ENV;
    expect(() => parseKeeperEnv(rest)).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_KEEPER_KEY is missing", () => {
    const { FLEET_KEEPER_KEY: _drop, ...rest } = BASE_ENV;
    expect(() => parseKeeperEnv(rest)).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_KEEPER_KEY is not a 32-byte hex key", () => {
    expect(() => parseKeeperEnv({ ...BASE_ENV, FLEET_KEEPER_KEY: "0xdead" })).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_POLL_MS is not a positive number", () => {
    expect(() => parseKeeperEnv({ ...BASE_ENV, FLEET_POLL_MS: "0" })).toThrow(EnvError);
    expect(() => parseKeeperEnv({ ...BASE_ENV, FLEET_POLL_MS: "not-a-number" })).toThrow(EnvError);
  });

  it("never includes the private key in a thrown message for an unrelated field", () => {
    try {
      parseKeeperEnv({ ...BASE_ENV, FLEET_POLL_MS: "-5" });
      expect.unreachable();
    } catch (err) {
      expect(err instanceof Error && err.message).not.toContain(KEY);
    }
  });
});

describe("loadManifest", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads and validates a manifest file", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-keeper-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify(VALID_MANIFEST));
    const manifest = loadManifest(file);
    expect(manifest.schema).toBe("fleet.manifest.v1");
    expect(manifest.chainId).toBe(31337);
  });

  it("throws EnvError for a missing file", () => {
    expect(() => loadManifest("/tmp/does-not-exist-fleet-manifest.json")).toThrow(EnvError);
  });

  it("throws EnvError for invalid JSON", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-keeper-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, "{ not json");
    expect(() => loadManifest(file)).toThrow(EnvError);
  });

  it("refuses a manifest for Base mainnet (final review I2)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-keeper-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, chainId: 8453 }));
    expect(() => loadManifest(file)).toThrow(/Base mainnet \(8453\) is refused in v1/);
  });

  it("refuses a manifest for any chain outside the v1 allowlist", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-keeper-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, chainId: 1 }));
    expect(() => loadManifest(file)).toThrow(EnvError);
  });

  it("accepts a Base Sepolia manifest", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-keeper-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, chainId: 84532 }));
    expect(loadManifest(file).chainId).toBe(84532);
  });

  it("throws EnvError for JSON that does not match ManifestV1", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-keeper-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, schema: "fleet.manifest.v2" }));
    expect(() => loadManifest(file)).toThrow(EnvError);
  });
});

describe("parseKeeperEnv: fee limits (final review M1)", () => {
  it("leaves both limits undefined when neither variable is set", () => {
    const env = parseKeeperEnv(BASE_ENV);
    expect(env.maxFeePerGasWei).toBeUndefined();
    expect(env.maxGas).toBeUndefined();
  });

  it("reads FLEET_MAX_FEE_PER_GAS_WEI and FLEET_MAX_GAS as bigints", () => {
    const env = parseKeeperEnv({ ...BASE_ENV, FLEET_MAX_FEE_PER_GAS_WEI: "50000000000", FLEET_MAX_GAS: "750000" });
    expect(env.maxFeePerGasWei).toBe(50_000_000_000n);
    expect(env.maxGas).toBe(750_000n);
  });

  it("rejects a non-integer or negative limit rather than truncating it", () => {
    expect(() => parseKeeperEnv({ ...BASE_ENV, FLEET_MAX_GAS: "1.5" })).toThrow(EnvError);
    expect(() => parseKeeperEnv({ ...BASE_ENV, FLEET_MAX_GAS: "0x1234" })).toThrow(EnvError);
    expect(() => parseKeeperEnv({ ...BASE_ENV, FLEET_MAX_FEE_PER_GAS_WEI: "-1" })).toThrow(EnvError);
    expect(() => parseKeeperEnv({ ...BASE_ENV, FLEET_MAX_FEE_PER_GAS_WEI: "0" })).toThrow(EnvError);
  });
});
