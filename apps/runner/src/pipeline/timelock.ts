import { bytesToHex, hexToBytes } from "viem";
import type { Address, Hex } from "viem";

/** `bytes32(0)`: the timelock's "no predecessor" sentinel, and this project never uses a
 *  predecessor for any governor-scheduled operation. */
export const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;

/**
 * Mirrors `GovernorTimelockControl._timelockSalt` exactly (the vendored OpenZeppelin
 * `contracts/lib/agora-governor/lib/openzeppelin-contracts/contracts/governance/extensions/
 * GovernorTimelockControl.sol`): `bytes20(address(this)) ^ descriptionHash`. Solidity widens the
 * 20-byte address to `bytes32` by right-padding with zero bytes (fixed-size `bytesN` types widen
 * that way, unlike integers), then XORs with the 32-byte description hash. Needed to independently
 * recompute the timelock operation id for a queued proposal (`timelock.hashOperationBatch`), since
 * `AgoraGovernor`'s own `_timelockIds` mapping is private.
 */
export function timelockSalt(governor: Address, descriptionHash: Hex): Hex {
  const addressBytes = hexToBytes(governor);
  const padded = new Uint8Array(32);
  padded.set(addressBytes.slice(0, 20), 0);
  const hashBytes = hexToBytes(descriptionHash);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = (padded[i] ?? 0) ^ (hashBytes[i] ?? 0);
  }
  return bytesToHex(out);
}
