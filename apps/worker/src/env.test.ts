import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvError, loadManifest, parseWorkerEnv } from "./env.js";

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

const KEY = ("0x" + "22".repeat(32)) as `0x${string}`;

const BASE_ENV = {
  FLEET_MANIFEST: "/tmp/does-not-matter.json",
  FLEET_RPC_HTTP: "http://127.0.0.1:8545",
  FLEET_AGENT_ID: "1",
  FLEET_AGENT_KEY: KEY,
  FLEET_POLICY: "scripted:FOR",
};

describe("parseWorkerEnv", () => {
  it("parses a minimal valid environment with defaults", () => {
    const env = parseWorkerEnv(BASE_ENV);
    expect(env).toEqual({
      manifestPath: "/tmp/does-not-matter.json",
      rpcHttpUrl: "http://127.0.0.1:8545",
      pgUrl: undefined,
      pollMs: 2000,
      logLevel: "info",
      agentId: 1,
      agentKey: KEY,
      policyDirective: "FOR",
      submissionMarginSec: 20,
    });
  });

  it("reads RUNNER_PG_URL, FLEET_POLL_MS, LOG_LEVEL, and FLEET_SUBMISSION_MARGIN_SEC when set", () => {
    const env = parseWorkerEnv({
      ...BASE_ENV,
      RUNNER_PG_URL: "postgres://localhost/fleet",
      FLEET_POLL_MS: "500",
      LOG_LEVEL: "debug",
      FLEET_SUBMISSION_MARGIN_SEC: "45",
    });
    expect(env.pgUrl).toBe("postgres://localhost/fleet");
    expect(env.pollMs).toBe(500);
    expect(env.logLevel).toBe("debug");
    expect(env.submissionMarginSec).toBe(45);
  });

  it.each(["FOR", "AGAINST", "ABSTAIN", "ABSENT", "MALFORMED", "LATE"])(
    "accepts scripted:%s as FLEET_POLICY",
    (directive) => {
      const env = parseWorkerEnv({ ...BASE_ENV, FLEET_POLICY: `scripted:${directive}` });
      expect(env.policyDirective).toBe(directive);
    },
  );

  it("throws EnvError for an unrecognized FLEET_POLICY directive", () => {
    expect(() => parseWorkerEnv({ ...BASE_ENV, FLEET_POLICY: "scripted:MAYBE" })).toThrow(EnvError);
  });

  it("throws EnvError for a FLEET_POLICY missing the scripted: prefix", () => {
    expect(() => parseWorkerEnv({ ...BASE_ENV, FLEET_POLICY: "FOR" })).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_MANIFEST is missing", () => {
    const { FLEET_MANIFEST: _drop, ...rest } = BASE_ENV;
    expect(() => parseWorkerEnv(rest)).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_AGENT_ID is missing", () => {
    const { FLEET_AGENT_ID: _drop, ...rest } = BASE_ENV;
    expect(() => parseWorkerEnv(rest)).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_AGENT_ID is negative or non-integer", () => {
    expect(() => parseWorkerEnv({ ...BASE_ENV, FLEET_AGENT_ID: "-1" })).toThrow(EnvError);
    expect(() => parseWorkerEnv({ ...BASE_ENV, FLEET_AGENT_ID: "1.5" })).toThrow(EnvError);
    expect(() => parseWorkerEnv({ ...BASE_ENV, FLEET_AGENT_ID: "not-a-number" })).toThrow(EnvError);
  });

  it("accepts FLEET_AGENT_ID of 0", () => {
    const env = parseWorkerEnv({ ...BASE_ENV, FLEET_AGENT_ID: "0" });
    expect(env.agentId).toBe(0);
  });

  it("throws EnvError when FLEET_AGENT_KEY is missing", () => {
    const { FLEET_AGENT_KEY: _drop, ...rest } = BASE_ENV;
    expect(() => parseWorkerEnv(rest)).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_AGENT_KEY is not a 32-byte hex key", () => {
    expect(() => parseWorkerEnv({ ...BASE_ENV, FLEET_AGENT_KEY: "0xdead" })).toThrow(EnvError);
  });

  it("throws EnvError when FLEET_SUBMISSION_MARGIN_SEC is negative", () => {
    expect(() => parseWorkerEnv({ ...BASE_ENV, FLEET_SUBMISSION_MARGIN_SEC: "-1" })).toThrow(EnvError);
  });

  it("never includes the private key in a thrown message for an unrelated field", () => {
    try {
      parseWorkerEnv({ ...BASE_ENV, FLEET_POLL_MS: "-5" });
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
    dir = mkdtempSync(path.join(tmpdir(), "fleet-worker-env-test-"));
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
    dir = mkdtempSync(path.join(tmpdir(), "fleet-worker-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, "{ not json");
    expect(() => loadManifest(file)).toThrow(EnvError);
  });

  it("refuses a manifest for Base mainnet (final review I2)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-worker-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, chainId: 8453 }));
    expect(() => loadManifest(file)).toThrow(/Base mainnet \(8453\) is refused in v1/);
  });

  it("refuses a manifest for any chain outside the v1 allowlist", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-worker-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, chainId: 1 }));
    expect(() => loadManifest(file)).toThrow(EnvError);
  });

  it("accepts a Base Sepolia manifest", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-worker-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, chainId: 84532 }));
    expect(loadManifest(file).chainId).toBe(84532);
  });

  it("throws EnvError for JSON that does not match ManifestV1", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-worker-env-test-"));
    const file = path.join(dir, "manifest.json");
    writeFileSync(file, JSON.stringify({ ...VALID_MANIFEST, schema: "fleet.manifest.v2" }));
    expect(() => loadManifest(file)).toThrow(EnvError);
  });
});
