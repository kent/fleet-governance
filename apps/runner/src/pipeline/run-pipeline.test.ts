import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadRunKeysFromEnv, manifestPathsForRun } from "./run-pipeline.js";

const KEY = (n: number) => `0x${n.toString().padStart(2, "0").repeat(32)}`;

describe("loadRunKeysFromEnv", () => {
  it("reads one env var per role plus one per agent", () => {
    const env = {
      FLEET_DEPLOYER_KEY: KEY(1),
      FLEET_OPERATOR_KEY: KEY(2),
      FLEET_GUARDIAN_KEY: KEY(3),
      FLEET_KEEPER_KEY: KEY(4),
      FLEET_AGENT_KEY_0: KEY(5),
      FLEET_AGENT_KEY_1: KEY(6),
    };
    const keys = loadRunKeysFromEnv(env, 2);
    expect(keys.deployerKey).toBe(KEY(1));
    expect(keys.operatorKey).toBe(KEY(2));
    expect(keys.guardianKey).toBe(KEY(3));
    expect(keys.keeperKey).toBe(KEY(4));
    expect(keys.agentKeys).toEqual({ 0: KEY(5), 1: KEY(6) });
  });

  it("throws naming the missing variable when an agent key is absent", () => {
    const env = {
      FLEET_DEPLOYER_KEY: KEY(1),
      FLEET_OPERATOR_KEY: KEY(2),
      FLEET_GUARDIAN_KEY: KEY(3),
      FLEET_KEEPER_KEY: KEY(4),
      FLEET_AGENT_KEY_0: KEY(5),
    };
    expect(() => loadRunKeysFromEnv(env, 2)).toThrow(/FLEET_AGENT_KEY_1/);
  });

  it("throws naming the missing variable when a role key is absent", () => {
    const env = { FLEET_OPERATOR_KEY: KEY(2), FLEET_GUARDIAN_KEY: KEY(3), FLEET_KEEPER_KEY: KEY(4) };
    expect(() => loadRunKeysFromEnv(env, 0)).toThrow(/FLEET_DEPLOYER_KEY/);
  });

  it("requests zero agent keys when memberCount is 0", () => {
    const env = {
      FLEET_DEPLOYER_KEY: KEY(1),
      FLEET_OPERATOR_KEY: KEY(2),
      FLEET_GUARDIAN_KEY: KEY(3),
      FLEET_KEEPER_KEY: KEY(4),
    };
    expect(loadRunKeysFromEnv(env, 0).agentKeys).toEqual({});
  });
});

describe("manifestPathsForRun (final review I8)", () => {
  it("writes under deployments/<chainId>/, the path the runbook and bootstrap-local.sh name", () => {
    const paths = manifestPathsForRun("/repo/deployments", 84532, "run-7");
    expect(paths.latest).toBe(path.join("/repo/deployments", "84532", "latest.json"));
    expect(paths.perRun).toBe(path.join("/repo/deployments", "84532", "run-run-7.json"));
  });

  it("uses the same latest.json on Anvil that bootstrap-local.sh writes", () => {
    expect(manifestPathsForRun("/repo/deployments", 31337, "run-1").latest).toBe(
      path.join("/repo/deployments", "31337", "latest.json"),
    );
  });

  it("gives two different runs on one chain different per-run copies", () => {
    const a = manifestPathsForRun("/repo/deployments", 31337, "run-a");
    const b = manifestPathsForRun("/repo/deployments", 31337, "run-b");
    expect(a.latest).toBe(b.latest);
    expect(a.perRun).not.toBe(b.perRun);
  });
});
