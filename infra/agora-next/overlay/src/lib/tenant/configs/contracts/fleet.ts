import { TenantContracts } from "@/lib/types";
import { base, baseSepolia, foundry } from "viem/chains";
import { JsonRpcProvider } from "ethers";
import { readFileSync } from "fs";
import {
  AgoraGovernorV2__factory,
  AgoraTimelock__factory,
  FleetVotes__factory,
} from "@/lib/contracts/generated";
import { TenantContract } from "@/lib/tenant/tenantContract";
import { IGovernorContract } from "@/lib/contracts/common/interfaces/IGovernorContract";
import { ITimelockContract } from "@/lib/contracts/common/interfaces/ITimelockContract";
import { createTokenContract } from "@/lib/tokenUtils";
import { DELEGATION_MODEL, GOVERNOR_TYPE, TIMELOCK_TYPE } from "@/lib/constants";
import { getRpcUrlForChain } from "@/lib/rpcConfig";

// Shape written by Task 6's deployment script. See fleet-governance's
// task-5-brief.md ("Interfaces: Consumes") and FleetDeployer.sol's
// FleetAddresses struct (contracts/src/deploy/FleetDeployer.sol) for the
// source addresses. Only governor/token/timelock are consumed by Agora
// Next itself; ledger/hook/registry are parsed but unused here (they are
// consumed by the fleet contracts stack, not this governance UI).
export type FleetDeployment = {
  chainId: number;
  governor: `0x${string}`;
  token: `0x${string}`;
  timelock: `0x${string}`;
  ledger: `0x${string}`;
  hook: `0x${string}`;
  registry: `0x${string}`;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function envPlaceholderDeployment(): FleetDeployment {
  return {
    chainId: Number(process.env.NEXT_PUBLIC_FLEET_CHAIN_ID ?? 31337),
    governor: (process.env.NEXT_PUBLIC_FLEET_GOVERNOR ??
      ZERO_ADDRESS) as `0x${string}`,
    token: (process.env.NEXT_PUBLIC_FLEET_TOKEN ?? ZERO_ADDRESS) as `0x${string}`,
    timelock: (process.env.NEXT_PUBLIC_FLEET_TIMELOCK ??
      ZERO_ADDRESS) as `0x${string}`,
    ledger: (process.env.NEXT_PUBLIC_FLEET_LEDGER ?? ZERO_ADDRESS) as `0x${string}`,
    hook: (process.env.NEXT_PUBLIC_FLEET_HOOK ?? ZERO_ADDRESS) as `0x${string}`,
    registry: (process.env.NEXT_PUBLIC_FLEET_REGISTRY ??
      ZERO_ADDRESS) as `0x${string}`,
  };
}

/**
 * Reads FLEET_DEPLOYMENT_FILE fresh on every call rather than caching it at
 * module scope. This task boots against a placeholder file; Task 6 replaces
 * it with the real deployment manifest, and a plain container restart (no
 * rebuild) should pick that up.
 */
export function loadFleetDeployment(): FleetDeployment {
  const file = process.env.FLEET_DEPLOYMENT_FILE;
  if (file) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as FleetDeployment;
    } catch (error) {
      console.error(
        `fleet tenant: failed to read FLEET_DEPLOYMENT_FILE at ${file}, falling back to NEXT_PUBLIC_FLEET_* env placeholders`,
        error
      );
    }
  }
  return envPlaceholderDeployment();
}

interface Props {
  isProd: boolean;
  rpcSecret: string;
}

export const fleetTenantContractConfig = ({
  isProd,
  rpcSecret,
}: Props): TenantContracts => {
  const deployment = loadFleetDeployment();

  // Local Anvil (chain id 31337) always wins, even when isProd is set,
  // since a production deployment never runs on 31337. Otherwise fall back
  // to Base mainnet or Base Sepolia depending on environment.
  const chain =
    deployment.chainId === 31337 ? foundry : isProd ? base : baseSepolia;

  const provider = new JsonRpcProvider(getRpcUrlForChain(chain.id, rpcSecret));

  return {
    token: createTokenContract({
      abi: FleetVotes__factory.abi,
      address: deployment.token,
      chain,
      contract: FleetVotes__factory.connect(deployment.token, provider),
      provider,
      type: "erc20",
    }),

    governor: new TenantContract<IGovernorContract>({
      abi: AgoraGovernorV2__factory.abi,
      address: deployment.governor,
      chain,
      contract: AgoraGovernorV2__factory.connect(deployment.governor, provider),
      provider,
    }),

    timelock: new TenantContract<ITimelockContract>({
      abi: AgoraTimelock__factory.abi,
      address: deployment.timelock,
      chain,
      contract: AgoraTimelock__factory.connect(deployment.timelock, provider),
      provider,
    }),

    delegationModel: DELEGATION_MODEL.FULL,
    governorType: GOVERNOR_TYPE.AGORA,
    // Fleet's timelock (contracts/src/deploy/FleetDeployer.sol) is a real
    // OpenZeppelin TimelockController with roles granted to the governor
    // (PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE), the same shape b3's
    // timelock uses. See docs/compatibility-notes.md, Task 5, "Timelock
    // type", for why this reuses b3's TIMELOCK_TYPE arm rather than
    // TIMELOCK_NO_ACCESS_CONTROL.
    timelockType: TIMELOCK_TYPE.TIMELOCKCONTROLLER_WITH_ACCESS_CONTROL_ERC721_ERC115,
    supportScopes: false,
  };
};
