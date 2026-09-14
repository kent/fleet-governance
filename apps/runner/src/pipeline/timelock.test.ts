import { describe, expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import type { Address } from "viem";
import { ZERO_BYTES32, timelockSalt } from "./timelock.js";

describe("timelockSalt", () => {
  it("matches bytes20(governor) right-padded, xored with the description hash, by construction", () => {
    const governor = "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707" as Address;
    const descriptionHash = keccak256(toHex("hello world"));
    const salt = timelockSalt(governor, descriptionHash);

    // Recompute independently, byte by byte, from the hex strings directly (no shared helpers
    // with the implementation under test).
    const addressHex = governor.slice(2).padEnd(64, "0"); // right-pad with zero bytes to 32 bytes
    const hashHex = descriptionHash.slice(2);
    let expected = "0x";
    for (let i = 0; i < 64; i += 2) {
      const a = parseInt(addressHex.slice(i, i + 2), 16);
      const b = parseInt(hashHex.slice(i, i + 2), 16);
      expected += (a ^ b).toString(16).padStart(2, "0");
    }
    expect(salt.toLowerCase()).toBe(expected.toLowerCase());
  });

  it("is deterministic for the same inputs", () => {
    const governor = "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707" as Address;
    const descriptionHash = keccak256(toHex("same description"));
    expect(timelockSalt(governor, descriptionHash)).toBe(timelockSalt(governor, descriptionHash));
  });

  it("differs when the description hash differs", () => {
    const governor = "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707" as Address;
    const a = timelockSalt(governor, keccak256(toHex("one")));
    const b = timelockSalt(governor, keccak256(toHex("two")));
    expect(a).not.toBe(b);
  });

  it("XORing back with the same governor address recovers the description hash", () => {
    const governor = "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707" as Address;
    const descriptionHash = keccak256(toHex("round trip"));
    const salt = timelockSalt(governor, descriptionHash);
    // XOR is its own inverse: salt ^ paddedAddress === descriptionHash.
    const roundTrip = timelockSalt(governor, salt);
    expect(roundTrip).toBe(descriptionHash);
  });

  it("ZERO_BYTES32 is 32 zero bytes", () => {
    expect(ZERO_BYTES32).toBe(`0x${"00".repeat(32)}`);
    expect(ZERO_BYTES32.length).toBe(66);
  });
});
