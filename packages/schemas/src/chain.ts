/**
 * The only chains v1 tooling is allowed to touch, keyed by the `target.kind` an
 * `ExperimentConfigV1` names. The overview plan's Global Constraints: "Chains: Anvil `31337`,
 * Base Sepolia `84532`. Mainnet `8453` is refused by every tool in v1", and spec 12.1: the config
 * panel "refuses `base-mainnet` outright".
 */
export const ALLOWED_CHAIN_IDS = {
  "local-anvil": 31337,
  "base-sepolia": 84532,
} as const;

export type AllowedChainKind = keyof typeof ALLOWED_CHAIN_IDS;

/** Base mainnet. Named so the refusal below reads as a deliberate rule rather than a gap in a
 *  list, and so nothing has to spell the literal 8453 at a call site. */
export const BASE_MAINNET_CHAIN_ID = 8453;

/** Thrown by `assertAllowedChain` for a chain id v1 refuses to operate on. Separate from every
 *  app's own env error so a caller can tell "the chain is wrong" from "the config is wrong". */
export class ChainNotAllowedError extends Error {
  readonly chainId: number;

  constructor(chainId: number, message: string) {
    super(message);
    this.name = "ChainNotAllowedError";
    this.chainId = chainId;
  }
}

/** Every chain id in `ALLOWED_CHAIN_IDS`, in declaration order. */
export function allowedChainIds(): number[] {
  return Object.values(ALLOWED_CHAIN_IDS);
}

/**
 * Throws unless `chainId` is one v1 is allowed to operate on. Base mainnet gets its own message
 * because it is the one refusal that is a policy decision rather than an unrecognized value: no
 * deployment, signature, or read in this repo may target a chain that holds real value
 * (spec 14's "Nothing in M0 to M4 grants mainnet authority").
 */
export function assertAllowedChain(chainId: number): void {
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    throw new ChainNotAllowedError(chainId, "Base mainnet (8453) is refused in v1");
  }
  if (!allowedChainIds().includes(chainId)) {
    throw new ChainNotAllowedError(
      chainId,
      `chain id ${chainId} is not an allowed v1 chain (allowed: ${allowedChainIds().join(", ")})`,
    );
  }
}

/** The chain id an experiment's `target.kind` must resolve to. Used by PREFLIGHT to compare what
 *  the configured RPC actually reports against what the config says it is pointing at. */
export function chainIdForKind(kind: AllowedChainKind): number {
  return ALLOWED_CHAIN_IDS[kind];
}
