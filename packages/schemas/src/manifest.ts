import { z } from "zod";
import { Address, DecimalString, Hex32 } from "./primitives.js";

export const ManifestV1 = z
  .object({
    schema: z.literal("fleet.manifest.v1"),
    chainId: z.number().int().positive(),
    deploymentBlock: z.number().int().nonnegative(),
    deploymentTimestamp: z.number().int().nonnegative(),
    deployer: Address,
    addresses: z
      .object({
        registry: Address,
        token: Address,
        timelock: Address,
        ledger: Address,
        hook: Address,
        governor: Address,
      })
      .strict(),
    hookSalt: Hex32,
    members: z.array(Address),
    operator: Address,
    guardian: Address,
    tokenName: z.string(),
    tokenSymbol: z.string(),
    configPath: z.string(),
    params: z
      .object({
        votingDelay: z.number().int().nonnegative(),
        votingPeriod: z.number().int().nonnegative(),
        proposalThreshold: DecimalString,
        quorumNumerator: z.number().int().min(1).max(10000),
        timelockDelay: z.number().int().nonnegative(),
        maxTaskLifetime: z.number().int().nonnegative(),
      })
      .strict(),
    countingRule: z.literal("for-only-quorum"),
    hookPermissionMask: z.literal("0x22C0"),
    configHash: Hex32,
    compiler: z
      .object({
        solc: z.string(),
        evm: z.string(),
        optimizerRuns: z.number().int().nonnegative(),
      })
      .strict(),
    pins: z
      .object({
        agoraGovernor: z.string(),
        openzeppelin: z.string(),
      })
      .strict(),
    codeHashes: z
      .object({
        registry: Hex32,
        token: Hex32,
        timelock: Hex32,
        ledger: Hex32,
        hook: Hex32,
        governor: Hex32,
      })
      .strict(),
  })
  .strict();
export type ManifestV1 = z.infer<typeof ManifestV1>;
