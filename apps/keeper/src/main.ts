import { createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FleetClient, Keeper, addressesFromManifest, explainRevert } from "@fleet/sdk";
import { keeperTick, listProposalIds } from "./discovery.js";
import { loadManifest, parseKeeperEnv } from "./env.js";
import { createLogger } from "./logger.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Keeper process entry point: loads the fleet manifest, builds a `FleetClient` and a raw viem
 * wallet for `FLEET_KEEPER_KEY`, then polls every `FLEET_POLL_MS` for proposals since the
 * manifest's `deploymentBlock` and calls `Keeper.reconcileProposal` on each one not already known
 * terminal. Runs until `SIGINT`/`SIGTERM`, finishing whatever poll is in flight before exiting 0.
 */
export async function main(): Promise<void> {
  const env = parseKeeperEnv();
  const logger = createLogger({ name: "keeper", level: env.logLevel });

  const manifest = loadManifest(env.manifestPath);
  const addresses = addressesFromManifest(manifest);

  // Keeper.reconcileProposal (packages/sdk/src/keeper.ts) re-reads proposal state and simulates
  // immediately before every send, so it needs no persisted nonce or job bookkeeping of its own;
  // RUNNER_PG_URL is read here only so the keeper never fails on an unrecognized env var when the
  // Runner sets one env file for every app, and to log which mode this process is in.
  if (env.pgUrl === undefined) {
    logger.warn(
      "RUNNER_PG_URL not set; the keeper holds no durable state of its own (Keeper.reconcileProposal re-reads chain state fresh every poll), continuing statelessly",
    );
  } else {
    logger.info(
      "RUNNER_PG_URL is set but unused: the keeper has no durable store (Keeper.reconcileProposal re-simulates and re-checks state immediately before every send)",
    );
  }

  const client = new FleetClient({ rpcUrl: env.rpcHttpUrl, chainId: manifest.chainId, addresses });
  // Final review M7: confirm the RPC really is the manifest's chain (and a chain v1 operates on)
  // once, before the first read, rather than trusting the manifest that was written from it.
  await client.assertChain();

  const account = privateKeyToAccount(env.keeperKey);
  const chain = defineChain({
    id: manifest.chainId,
    name: `fleet-governance-${manifest.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.rpcHttpUrl] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(env.rpcHttpUrl) });
  const keeper = new Keeper({
    client,
    wallet,
    addresses,
    // Spec 10.7's "configured fee limits" (final review M1): unset means unbounded.
    feeLimits: {
      ...(env.maxFeePerGasWei !== undefined ? { maxFeePerGasWei: env.maxFeePerGasWei } : {}),
      ...(env.maxGas !== undefined ? { maxGas: env.maxGas } : {}),
    },
  });

  logger.info(
    { keeperAddress: account.address, chainId: manifest.chainId, governor: addresses.governor, pollMs: env.pollMs },
    "keeper starting",
  );

  const fromBlock = BigInt(manifest.deploymentBlock);
  const terminalIds = new Set<string>();

  let stopping = false;
  let currentTick: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    await keeperTick({
      listProposalIds: (from) => listProposalIds(client, from),
      reconcileProposal: (id) => keeper.reconcileProposal(id),
      fromBlock,
      terminalIds,
      onResult: (id, result) => {
        logger.info({ proposalId: id.toString(), result }, "reconciled proposal");
      },
      onError: (id, err) => {
        logger.error({ proposalId: id.toString(), error: explainRevert(err) }, "reconcile failed");
      },
    });
  }

  function requestShutdown(signal: string): void {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutdown requested; finishing the poll in flight");
    void currentTick.finally(() => {
      logger.info("shutdown complete");
      process.exit(0);
    });
  }

  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));

  while (!stopping) {
    currentTick = tick().catch((err) => {
      logger.error({ error: errorMessage(err) }, "poll tick failed");
    });
    await currentTick;
    if (stopping) break;
    await delay(env.pollMs);
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(errorMessage(err));
    process.exit(1);
  });
}
