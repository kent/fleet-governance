import { describe, expect, it } from "vitest";
import { RunnerEnvError, parseSignerFeeLimits, requirePrivateKeyEnv } from "./env.js";

const KEY = `0x${"11".repeat(32)}`;

describe("requirePrivateKeyEnv", () => {
  it("returns a well-formed key", () => {
    expect(requirePrivateKeyEnv({ FLEET_DEPLOYER_KEY: KEY }, "FLEET_DEPLOYER_KEY")).toBe(KEY);
  });

  it("names the variable, never the value, when it is missing or malformed", () => {
    expect(() => requirePrivateKeyEnv({}, "FLEET_DEPLOYER_KEY")).toThrow(/FLEET_DEPLOYER_KEY/);
    try {
      requirePrivateKeyEnv({ FLEET_DEPLOYER_KEY: "0xnope" }, "FLEET_DEPLOYER_KEY");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerEnvError);
      expect((err as Error).message).toContain("FLEET_DEPLOYER_KEY");
      expect((err as Error).message).not.toContain("0xnope");
    }
  });
});

describe("parseSignerFeeLimits (final review M1)", () => {
  it("is empty when neither variable is set, which means unbounded", () => {
    expect(parseSignerFeeLimits({})).toEqual({});
  });

  it("reads FLEET_MAX_FEE_PER_GAS_WEI and FLEET_MAX_GAS as bigints", () => {
    expect(parseSignerFeeLimits({ FLEET_MAX_FEE_PER_GAS_WEI: "50000000000", FLEET_MAX_GAS: "750000" })).toEqual({
      maxFeePerGasWei: 50_000_000_000n,
      maxGas: 750_000n,
    });
  });

  it("reads one limit without the other", () => {
    expect(parseSignerFeeLimits({ FLEET_MAX_GAS: "750000" })).toEqual({ maxGas: 750_000n });
    expect(parseSignerFeeLimits({ FLEET_MAX_FEE_PER_GAS_WEI: "7" })).toEqual({ maxFeePerGasWei: 7n });
  });

  it("rejects a non-integer, hex, negative or zero limit rather than truncating it", () => {
    expect(() => parseSignerFeeLimits({ FLEET_MAX_GAS: "1.5" })).toThrow(RunnerEnvError);
    expect(() => parseSignerFeeLimits({ FLEET_MAX_GAS: "0x1234" })).toThrow(RunnerEnvError);
    expect(() => parseSignerFeeLimits({ FLEET_MAX_FEE_PER_GAS_WEI: "-1" })).toThrow(RunnerEnvError);
    expect(() => parseSignerFeeLimits({ FLEET_MAX_FEE_PER_GAS_WEI: "0" })).toThrow(RunnerEnvError);
  });
});
