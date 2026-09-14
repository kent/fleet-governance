import type { Address } from "viem";
import type { ManifestV1 } from "@fleet/schemas";

/** The six contracts one fleet deployment carries, keyed the way every other part of the SDK
 *  expects them (matches `ManifestV1.addresses` and `FleetDeployer.deploy`'s return struct). */
export type FleetAddresses = {
  registry: Address;
  token: Address;
  timelock: Address;
  ledger: Address;
  hook: Address;
  governor: Address;
  executor?: Address;
  artifactStore?: Address;
};

/**
 * Projects a parsed `ManifestV1` (see `@fleet/schemas`) down to the six addresses the SDK reads
 * and writes against. `ManifestV1.addresses.*` is already validated and lowercase-normalized at
 * the schema boundary, so this is a plain field-by-field copy, not a re-validation.
 */
export function addressesFromManifest(m: ManifestV1): FleetAddresses {
  return {
    registry: m.addresses.registry as Address,
    token: m.addresses.token as Address,
    timelock: m.addresses.timelock as Address,
    ledger: m.addresses.ledger as Address,
    hook: m.addresses.hook as Address,
    governor: m.addresses.governor as Address,
    ...(m.addresses.executor ? { executor: m.addresses.executor as Address } : {}),
    ...(m.addresses.artifactStore ? { artifactStore: m.addresses.artifactStore as Address } : {}),
  };
}
