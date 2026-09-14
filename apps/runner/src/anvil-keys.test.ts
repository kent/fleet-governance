import { describe, expect, it } from "vitest";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { anvilDevKey, ANVIL_DEV_MNEMONIC, DEMO_ACCOUNT_INDEX } from "./anvil-keys.js";

describe("Anvil fleet identities", () => {
  it("keeps thousands of members disjoint from every administrative role", () => {
    const indices = Array.from({ length: 4096 }, (_, i) => DEMO_ACCOUNT_INDEX.agent(i));
    expect(new Set(indices).size).toBe(4096);
    for (const admin of [DEMO_ACCOUNT_INDEX.deployer, DEMO_ACCOUNT_INDEX.operator, DEMO_ACCOUNT_INDEX.guardian, DEMO_ACCOUNT_INDEX.keeper]) {
      expect(indices).not.toContain(admin);
    }
    expect(indices.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each([0, 1, 9, 10, 1200, 4100])("derives standard Anvil account %s", (index) => {
    expect(privateKeyToAccount(anvilDevKey(index)).address).toBe(mnemonicToAccount(ANVIL_DEV_MNEMONIC, { addressIndex: index }).address);
  });
});
