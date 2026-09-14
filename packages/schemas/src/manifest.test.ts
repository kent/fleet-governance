import { describe, expect, it } from "vitest";
import { ManifestV1 } from "./manifest.js";

function fakeAddress(i: number): string {
  return "0x" + i.toString(16).padStart(40, "0");
}

function fakeHex32(i: number): string {
  return "0x" + i.toString(16).padStart(64, "0");
}

const validManifest = {
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
  members: [fakeAddress(10), fakeAddress(11), fakeAddress(12), fakeAddress(13), fakeAddress(14)],
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
  configHash: fakeHex32(0xd16585),
  compiler: { solc: "0.8.29", evm: "cancun", optimizerRuns: 200 },
  pins: {
    agoraGovernor: "11a11641ce1f4f691c300d530eae3c7203593b85",
    openzeppelin: "3d139e998b9843179d72b28a3264834b01baf160",
  },
  codeHashes: {
    registry: fakeHex32(21),
    token: fakeHex32(22),
    timelock: fakeHex32(23),
    ledger: fakeHex32(24),
    hook: fakeHex32(25),
    governor: fakeHex32(26),
  },
};

describe("ManifestV1", () => {
  it("requires both execution resource addresses and their code hashes, or none for historical manifests", () => {
    const complete = { ...validManifest, addresses: { ...validManifest.addresses, executor: fakeAddress(30), artifactStore: fakeAddress(31) },
      codeHashes: { ...validManifest.codeHashes, executor: fakeHex32(30), artifactStore: fakeHex32(31) } };
    expect(ManifestV1.safeParse(complete).success).toBe(true);
    for (const group of ["addresses", "codeHashes"] as const) {
      for (const field of ["executor", "artifactStore"] as const) {
        const partial = structuredClone(complete);
        delete (partial[group] as Record<string, unknown>)[field];
        expect(ManifestV1.safeParse(partial).success).toBe(false);
      }
    }
  });
  it("parses a valid manifest", () => {
    expect(ManifestV1.parse(validManifest)).toEqual(validManifest);
  });

  it("rejects the wrong schema literal", () => {
    expect(() => ManifestV1.parse({ ...validManifest, schema: "fleet.manifest.v2" })).toThrow();
  });

  it("rejects an extra key", () => {
    expect(() => ManifestV1.parse({ ...validManifest, extra: true })).toThrow();
  });

  it("rejects an extra key in a nested object", () => {
    expect(() =>
      ManifestV1.parse({ ...validManifest, addresses: { ...validManifest.addresses, extra: fakeAddress(99) } }),
    ).toThrow();
  });

  it("rejects a bad deployer address", () => {
    expect(() => ManifestV1.parse({ ...validManifest, deployer: "not-an-address" })).toThrow();
  });

  it("rejects a bad hookSalt", () => {
    expect(() => ManifestV1.parse({ ...validManifest, hookSalt: "0x1234" })).toThrow();
  });

  it("rejects a bad decimal string proposalThreshold", () => {
    expect(() =>
      ManifestV1.parse({ ...validManifest, params: { ...validManifest.params, proposalThreshold: "1e18" } }),
    ).toThrow();
  });

  it("rejects a quorumNumerator over 10000", () => {
    expect(() =>
      ManifestV1.parse({ ...validManifest, params: { ...validManifest.params, quorumNumerator: 10001 } }),
    ).toThrow();
  });

  it("rejects the wrong hookPermissionMask literal", () => {
    expect(() => ManifestV1.parse({ ...validManifest, hookPermissionMask: "0x22c0" })).toThrow();
  });

  it("rejects the wrong countingRule literal", () => {
    expect(() => ManifestV1.parse({ ...validManifest, countingRule: "quorum-fraction" })).toThrow();
  });

  it("rejects a bad codeHashes entry", () => {
    expect(() =>
      ManifestV1.parse({ ...validManifest, codeHashes: { ...validManifest.codeHashes, registry: "0xnothex" } }),
    ).toThrow();
  });

  it("normalizes addresses to lowercase", () => {
    const lowercase = fakeAddress(0xabc1);
    const mixedCase = lowercase.toUpperCase().replace("0X", "0x");
    const parsed = ManifestV1.parse({ ...validManifest, deployer: mixedCase });
    expect(parsed.deployer).toBe(lowercase);
  });
});
