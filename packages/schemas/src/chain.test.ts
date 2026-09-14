import { describe, expect, it } from "vitest";
import {
  ALLOWED_CHAIN_IDS,
  BASE_MAINNET_CHAIN_ID,
  ChainNotAllowedError,
  allowedChainIds,
  assertAllowedChain,
  chainIdForKind,
} from "./chain.js";

describe("assertAllowedChain (final review I2)", () => {
  it("accepts the two chains v1 operates on", () => {
    expect(() => assertAllowedChain(31337)).not.toThrow();
    expect(() => assertAllowedChain(84532)).not.toThrow();
  });

  it("refuses Base mainnet by name", () => {
    expect(() => assertAllowedChain(BASE_MAINNET_CHAIN_ID)).toThrow("Base mainnet (8453) is refused in v1");
  });

  it("refuses any chain id outside the allowed set", () => {
    for (const chainId of [1, 10, 137, 8453, 84531, 0]) {
      expect(() => assertAllowedChain(chainId)).toThrow(ChainNotAllowedError);
    }
  });

  it("names the allowed ids in the refusal, so an operator can see what is permitted", () => {
    expect(() => assertAllowedChain(1)).toThrow(/allowed: 31337, 84532/);
  });

  it("carries the offending chain id on the error", () => {
    try {
      assertAllowedChain(BASE_MAINNET_CHAIN_ID);
      throw new Error("assertAllowedChain did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ChainNotAllowedError);
      expect((err as ChainNotAllowedError).chainId).toBe(8453);
    }
  });
});

describe("ALLOWED_CHAIN_IDS", () => {
  it("maps every experiment target kind to its chain id", () => {
    expect(ALLOWED_CHAIN_IDS).toEqual({ "local-anvil": 31337, "base-sepolia": 84532 });
    expect(chainIdForKind("local-anvil")).toBe(31337);
    expect(chainIdForKind("base-sepolia")).toBe(84532);
    expect(allowedChainIds()).toEqual([31337, 84532]);
  });
});
