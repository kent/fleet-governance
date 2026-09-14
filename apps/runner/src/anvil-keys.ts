import { bytesToHex } from "viem";
import type { Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";

/** Foundry/Hardhat's well-known development mnemonic. Anvil derives its ten default dev accounts
 *  from this exact phrase whenever it is started without `--mnemonic`; every account and private
 *  key it prints at startup (and every address named in the task 8 controller notes) is this
 *  mnemonic's `m/44'/60'/0'/0/<index>` derivation. Test-only: never controls anything of value. */
export const ANVIL_DEV_MNEMONIC = "test test test test test test test test test test test junk";
const devAccountParent = mnemonicToAccount(ANVIL_DEV_MNEMONIC, { path: "m/44'/60'/0'/0" }).getHdKey();

/**
 * Derives Anvil's default dev account `index`'s private key directly from `ANVIL_DEV_MNEMONIC`,
 * rather than hardcoding the raw key material. `fleet demo` uses this for every role (deployer,
 * agents, operator, guardian, keeper) when no other key source is configured, since the demo's
 * whole CLI surface (`fleet demo --rpc <url> [--fresh-anvil]`) takes no key flags: it is always a
 * local Anvil (fresh or the Part 2 compose stack), which always uses this mnemonic unless someone
 * has deliberately reconfigured it.
 */
export function anvilDevKey(index: number): Hex {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) throw new Error("invalid Anvil account index");
  const privateKey = devAccountParent.deriveChild(index).privateKey;
  if (!privateKey) {
    throw new Error(`could not derive a private key for Anvil dev account index ${index}`);
  }
  return bytesToHex(privateKey);
}

/** The role -> Anvil dev account index mapping `fleet demo` uses (matches
 *  `deployments/configs/local-5.json`'s `members` order and the established convention from
 *  `apps/worker/src/fleet-smoke.integration.test.ts`: "agentId N registers to anvil account index
 *  N+1" for the first five agents, operator at 6, guardian at 7, keeper at 9). Larger fleets
 *  start additional members at account 10 so no member also controls an administrative role. */
export const DEMO_ACCOUNT_INDEX = {
  deployer: 0,
  agent: (agentId: number): number => agentId < 5 ? agentId + 1 : agentId + 5,
  operator: 6,
  guardian: 7,
  keeper: 9,
} as const;
