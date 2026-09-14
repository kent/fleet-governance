import { createPublicClient, http } from "viem";

/** Injectable so `route.test.ts` can assert behavior for a given chain id without any real RPC
 *  call (controller notes item 3 / item 7: "Inject ... the chain-id probe ... into the handler"). */
export type ChainIdProbe = (rpcHttp: string) => Promise<number>;

/** Reads the target chain's id with a 5 second timeout. A read-only client with no wallet and no
 *  contract addresses: this only ever calls `eth_chainId`. */
export const defaultChainIdProbe: ChainIdProbe = async (rpcHttp) => {
  const client = createPublicClient({ transport: http(rpcHttp, { timeout: 5000 }) });
  return client.getChainId();
};

/** `ExperimentConfigV1.target.kind` -> the chain id that target is expected to report. */
export const CHAIN_ID_BY_TARGET_KIND = {
  "local-anvil": 31337,
  "base-sepolia": 84532,
} as const satisfies Record<string, number>;

/** Base mainnet: spec 16.4 authorizes local and Base Sepolia work only in v0.1. */
export const BASE_MAINNET_CHAIN_ID = 8453;
