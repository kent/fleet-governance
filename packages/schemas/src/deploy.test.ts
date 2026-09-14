import { describe, expect, it } from "vitest";
import { DeployConfigV1 } from "./deploy.js";

function fakeAddress(i: number): string {
  return "0x" + i.toString(16).padStart(40, "0");
}

const validDeployConfig = {
  schema: "fleet.deploy.v1",
  tokenName: "Fleet Vote",
  tokenSymbol: "FLEET",
  members: [fakeAddress(1), fakeAddress(2), fakeAddress(3), fakeAddress(4), fakeAddress(5)],
  agentManifests: [
    '{"role":"planner","provider":"scripted","model":"scripted-v1","promptVersion":"1","operator":"local"}',
    '{"role":"engineer","provider":"scripted","model":"scripted-v1","promptVersion":"1","operator":"local"}',
    '{"role":"critic","provider":"scripted","model":"scripted-v1","promptVersion":"1","operator":"local"}',
    '{"role":"budget","provider":"scripted","model":"scripted-v1","promptVersion":"1","operator":"local"}',
    '{"role":"safety","provider":"scripted","model":"scripted-v1","promptVersion":"1","operator":"local"}',
  ],
  fleetManifest: '{"experiment":"local-5","constitution":"fleet.constitution.v1","harness":"dev"}',
  operator: fakeAddress(6),
  guardian: fakeAddress(7),
  votingDelay: 15,
  votingPeriod: 120,
  proposalThreshold: "1000000000000000000",
  quorumNumerator: 6000,
  timelockDelay: 30,
  maxTaskLifetime: 7200,
};

describe("DeployConfigV1", () => {
  it("parses a valid deploy config", () => {
    expect(DeployConfigV1.parse(validDeployConfig)).toEqual(validDeployConfig);
  });

  it("rejects the wrong schema literal", () => {
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, schema: "fleet.deploy.v2" })).toThrow();
  });

  it("rejects an extra key", () => {
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, extra: true })).toThrow();
  });

  it("rejects a bad operator address", () => {
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, operator: "not-an-address" })).toThrow();
  });

  it("rejects a bad decimal string proposalThreshold", () => {
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, proposalThreshold: "1.5" })).toThrow();
  });

  it("rejects a quorumNumerator of 0", () => {
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, quorumNumerator: 0 })).toThrow();
  });

  it("rejects a quorumNumerator over 10000", () => {
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, quorumNumerator: 10001 })).toThrow();
  });

  it("rejects fewer than 2 members", () => {
    expect(() =>
      DeployConfigV1.parse({
        ...validDeployConfig,
        members: [fakeAddress(1)],
        agentManifests: [validDeployConfig.agentManifests[0]!],
      }),
    ).toThrow();
  });

  it("rejects more than 64 members", () => {
    const members = Array.from({ length: 65 }, (_, i) => fakeAddress(i + 1));
    const agentManifests = Array.from({ length: 65 }, () => validDeployConfig.agentManifests[0]!);
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, members, agentManifests })).toThrow();
  });

  it("rejects duplicate members", () => {
    const members = [fakeAddress(1), fakeAddress(1), fakeAddress(3), fakeAddress(4), fakeAddress(5)];
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, members })).toThrow();
  });

  it("rejects duplicate members that differ only by case", () => {
    const base = fakeAddress(0xabc);
    const members = [base, base.toUpperCase().replace("0X", "0x"), fakeAddress(3), fakeAddress(4), fakeAddress(5)];
    expect(() => DeployConfigV1.parse({ ...validDeployConfig, members })).toThrow();
  });

  it("rejects agentManifests with a different length than members", () => {
    expect(() =>
      DeployConfigV1.parse({
        ...validDeployConfig,
        agentManifests: validDeployConfig.agentManifests.slice(0, 4),
      }),
    ).toThrow();
  });
});
