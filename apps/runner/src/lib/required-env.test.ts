import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNT_INDEX } from "../anvil-keys.js";
import { classifyRequiredEnvVars, findMissingEnvVar, requiredEnvVarNames } from "./required-env.js";

const KEY = `0x${"11".repeat(32)}`;

describe("requiredEnvVarNames", () => {
  it("names one key per fixed role plus one per member, and OpenRouter only when a member uses it", () => {
    expect(requiredEnvVarNames({ memberCount: 2, anyOpenRouter: false })).toEqual([
      "FLEET_DEPLOYER_KEY",
      "FLEET_OPERATOR_KEY",
      "FLEET_GUARDIAN_KEY",
      "FLEET_KEEPER_KEY",
      "FLEET_AGENT_KEY_0",
      "FLEET_AGENT_KEY_1",
    ]);
    expect(requiredEnvVarNames({ memberCount: 0, anyOpenRouter: true })).toContain("OPENROUTER_API_KEY");
  });
});

describe("classifyRequiredEnvVars", () => {
  const names = requiredEnvVarNames({ memberCount: 1, anyOpenRouter: true });

  it("reports a set variable as coming from the environment", () => {
    const classified = classifyRequiredEnvVars(["FLEET_KEEPER_KEY"], { FLEET_KEEPER_KEY: KEY }, { localAnvil: true });
    expect(classified[0]).toEqual({ name: "FLEET_KEEPER_KEY", present: true, source: "env" });
  });

  it("reports an unset private-key variable as satisfied by the local Anvil test key, naming the account index only", () => {
    const classified = classifyRequiredEnvVars(names, {}, { localAnvil: true });
    const keeper = classified.find((c) => c.name === "FLEET_KEEPER_KEY");
    expect(keeper).toEqual({
      name: "FLEET_KEEPER_KEY",
      present: true,
      source: "local-anvil-test-key",
      anvilAccountIndex: DEMO_ACCOUNT_INDEX.keeper,
    });
    const agent0 = classified.find((c) => c.name === "FLEET_AGENT_KEY_0");
    expect(agent0?.anvilAccountIndex).toBe(DEMO_ACCOUNT_INDEX.agent(0));
    for (const entry of classified) {
      expect(JSON.stringify(entry)).not.toMatch(/0x[0-9a-fA-F]{64}/);
    }
  });

  it("never substitutes OPENROUTER_API_KEY, which has no public stand-in", () => {
    const classified = classifyRequiredEnvVars(names, {}, { localAnvil: true });
    expect(classified.find((c) => c.name === "OPENROUTER_API_KEY")).toEqual({
      name: "OPENROUTER_API_KEY",
      present: false,
      source: "missing",
    });
  });

  it("reports everything unset as missing on any other target", () => {
    const classified = classifyRequiredEnvVars(names, {}, { localAnvil: false });
    expect(classified.every((c) => c.source === "missing" && !c.present)).toBe(true);
  });

  it("treats a blank variable as unset", () => {
    const classified = classifyRequiredEnvVars(["FLEET_OPERATOR_KEY"], { FLEET_OPERATOR_KEY: "  " }, { localAnvil: true });
    expect(classified[0]?.source).toBe("local-anvil-test-key");
  });
});

describe("findMissingEnvVar", () => {
  const names = requiredEnvVarNames({ memberCount: 1, anyOpenRouter: false });

  it("names the first unset variable when no fallback applies", () => {
    expect(findMissingEnvVar(names, {})).toBe("FLEET_DEPLOYER_KEY");
    expect(findMissingEnvVar(names, {}, { localAnvil: false })).toBe("FLEET_DEPLOYER_KEY");
  });

  it("reports nothing missing on a local Anvil with no keys set at all", () => {
    expect(findMissingEnvVar(names, {}, { localAnvil: true })).toBeNull();
  });

  it("still reports a missing OpenRouter key on a local Anvil", () => {
    const withOpenRouter = requiredEnvVarNames({ memberCount: 0, anyOpenRouter: true });
    expect(findMissingEnvVar(withOpenRouter, {}, { localAnvil: true })).toBe("OPENROUTER_API_KEY");
  });
});
