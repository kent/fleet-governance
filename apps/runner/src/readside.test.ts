import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readEnvValue, readside, setEnvValue } from "./readside.js";

const currentDir = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(currentDir, "../../..");
// A committed historical manifest, never the mutable latest.json written by experiment runs.
const realManifestPath = path.join(repoRoot, "deployments", "31337", "1789373295.json");
const abiSourceDir = path.join(repoRoot, "packages", "abi", "abis");

describe("readEnvValue / setEnvValue", () => {
  it("readEnvValue returns the fallback for a missing key", () => {
    expect(readEnvValue("FOO=bar\n", "BAZ", "default")).toBe("default");
  });

  it("readEnvValue reads a bare value", () => {
    expect(readEnvValue("FOO=bar\nBAZ=qux\n", "BAZ", "default")).toBe("qux");
  });

  it("readEnvValue strips surrounding quotes", () => {
    expect(readEnvValue('FOO="bar baz"\n', "FOO", "default")).toBe("bar baz");
  });

  it("readEnvValue: the last occurrence wins", () => {
    expect(readEnvValue("FOO=first\nFOO=second\n", "FOO", "default")).toBe("second");
  });

  it("readEnvValue falls back on an empty value", () => {
    expect(readEnvValue("FOO=\n", "FOO", "default")).toBe("default");
  });

  it("setEnvValue replaces an existing key in place, leaving other lines untouched", () => {
    const before = "# comment\nFOO=old\nBAR=keep\n";
    const after = setEnvValue(before, "FOO", "new");
    expect(after).toBe("# comment\nFOO=new\nBAR=keep\n");
  });

  it("setEnvValue appends a missing key with a trailing newline", () => {
    const after = setEnvValue("FOO=bar\n", "BAZ", "qux");
    expect(after).toBe("FOO=bar\nBAZ=qux\n");
  });

  it("setEnvValue appends to text with no trailing newline", () => {
    const after = setEnvValue("FOO=bar", "BAZ", "qux");
    expect(after).toBe("FOO=bar\nBAZ=qux\n");
  });
});

describe("readside (temp-dir fakes, no Docker)", () => {
  let dir: string;
  let infraDir: string;
  let deploymentsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-readside-"));
    infraDir = path.join(dir, "infra");
    deploymentsDir = path.join(dir, "deployments");
    mkdirSync(infraDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates infra/.env from .env.example, preserving other keys, and writes ABIs plus the agora-next deployment file", async () => {
    writeFileSync(
      path.join(infraDir, ".env.example"),
      "ANVIL_PORT=8545\nTOKEN_ADDRESS=0x0000000000000000000000000000000000000000\nGOVERNOR_ADDRESS=0x0000000000000000000000000000000000000000\nDAO_NODE_START_BLOCK=0\n",
    );

    const result = await readside({
      manifestPath: realManifestPath,
      infraDir,
      abiSourceDir,
      deploymentsDir,
    });

    const envText = readFileSync(path.join(infraDir, ".env"), "utf8");
    expect(envText).toContain("ANVIL_PORT=8545");
    expect(envText).toContain("TOKEN_ADDRESS=0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
    expect(envText).toContain("GOVERNOR_ADDRESS=0x5fc8d32690cc91d4c39d9d3abcbd16989f875707");
    expect(envText).toContain("DAO_NODE_START_BLOCK=1");

    expect(existsSync(result.tokenAbiFile)).toBe(true);
    expect(existsSync(result.governorAbiFile)).toBe(true);
    expect(path.basename(result.tokenAbiFile)).toBe("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512.json");
    expect(path.basename(result.governorAbiFile)).toBe("0x5fc8d32690cc91d4c39d9d3abcbd16989f875707.json");
    const tokenAbi = JSON.parse(readFileSync(result.tokenAbiFile, "utf8"));
    expect(Array.isArray(tokenAbi)).toBe(true);

    const deployment = JSON.parse(readFileSync(result.agoraNextDeploymentFile, "utf8"));
    expect(deployment).toEqual({
      chainId: 31337,
      governor: "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707",
      token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512",
      timelock: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
      ledger: "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9",
      hook: "0xa8d43557a9d305d0b2f98bfebe07dc0a8db522c0",
      registry: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    });
    expect(result.restarted).toBe(false);
  });

  it("is idempotent: a second run against the same manifest overwrites the same files without error", async () => {
    writeFileSync(path.join(infraDir, ".env.example"), "ANVIL_PORT=8545\n");
    await readside({ manifestPath: realManifestPath, infraDir, abiSourceDir, deploymentsDir });
    const second = await readside({ manifestPath: realManifestPath, infraDir, abiSourceDir, deploymentsDir });
    expect(existsSync(second.envFile)).toBe(true);
    const envText = readFileSync(second.envFile, "utf8");
    expect((envText.match(/TOKEN_ADDRESS=/g) ?? []).length).toBe(1);
  });

  it("creates infra/.env from scratch when there is no .env or .env.example", async () => {
    const result = await readside({ manifestPath: realManifestPath, infraDir, abiSourceDir, deploymentsDir });
    const envText = readFileSync(result.envFile, "utf8");
    expect(envText).toContain("TOKEN_ADDRESS=0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
  });

  it("throws RunnerEnvError for a manifest that does not exist", async () => {
    await expect(
      readside({ manifestPath: path.join(dir, "missing.json"), infraDir, abiSourceDir, deploymentsDir }),
    ).rejects.toThrow(/could not read manifest/);
  });

  it("throws RunnerEnvError for a manifest that does not parse as fleet.manifest.v1", async () => {
    const badManifest = path.join(dir, "bad.json");
    writeFileSync(badManifest, JSON.stringify({ schema: "fleet.manifest.v1" }));
    await expect(readside({ manifestPath: badManifest, infraDir, abiSourceDir, deploymentsDir })).rejects.toThrow(
      /does not parse as fleet\.manifest\.v1/,
    );
  });
});
