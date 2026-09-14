import {
  FleetSigner,
  MemoryNonceStore,
  NonceManager,
  ProposalState,
  addressesFromManifest,
  explainRevert,
} from "@fleet/sdk";
import type { SignerPolicy } from "@fleet/sdk";
import { MemoryJobStore, PgJobStore, PgNonceStore, ScriptedPolicy, Worker } from "@fleet/agent-runtime";
import type { JobStore } from "@fleet/agent-runtime";
import { FleetClient } from "@fleet/sdk";
import { listProposalIds, workerTick } from "./discovery.js";
import { loadManifest, parseWorkerEnv } from "./env.js";
import { createLogger } from "./logger.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Worker process entry point: loads the fleet manifest, builds a `FleetClient`, a
 * `NonceManager`, a `FleetSigner` for `FLEET_AGENT_KEY`, a `JobStore`, and a `ScriptedPolicy`
 * driven by `FLEET_POLICY`, then polls every `FLEET_POLL_MS` for `Active` proposals since the
 * manifest's `deploymentBlock` and calls `Worker.handleProposal` on each one not already known
 * done. Runs until `SIGINT`/`SIGTERM`, finishing whatever poll is in flight before exiting 0.
 */
export async function main(): Promise<void> {
  const env = parseWorkerEnv();
  const logger = createLogger({ name: "worker", level: env.logLevel });

  const manifest = loadManifest(env.manifestPath);
  const addresses = addressesFromManifest(manifest);

  const usingPg = env.pgUrl !== undefined;
  if (!usingPg) {
    logger.warn("RUNNER_PG_URL not set; using in-memory nonce and job stores, which do not survive a restart");
  } else {
    logger.info("RUNNER_PG_URL set; using durable Postgres-backed nonce and job stores");
  }

  const nonceStore = usingPg ? new PgNonceStore(env.pgUrl!) : new MemoryNonceStore();
  const jobStore: JobStore = usingPg ? new PgJobStore(env.pgUrl!) : new MemoryJobStore();
  if (usingPg) {
    // Both PgNonceStore.migrate and PgJobStore.migrate apply the same CREATE TABLE IF NOT EXISTS
    // migration file (packages/agent-runtime/src/migrations/001_jobs.sql), so calling one is
    // enough; both are called for clarity and because either store could migrate first safely.
    await (nonceStore as PgNonceStore).migrate();
    await (jobStore as PgJobStore).migrate();
  }

  const client = new FleetClient({ rpcUrl: env.rpcHttpUrl, chainId: manifest.chainId, addresses });
  const nonces = new NonceManager(nonceStore, env.rpcHttpUrl);

  const signerPolicy: SignerPolicy = {
    chainId: manifest.chainId,
    governor: addresses.governor,
    ledger: addresses.ledger,
    token: addresses.token,
  };
  const signer = new FleetSigner({ privateKey: env.agentKey, rpcUrl: env.rpcHttpUrl, policy: signerPolicy, nonces });

  const policy = new ScriptedPolicy({ [env.agentId]: env.policyDirective });

  const worker = new Worker({
    agentId: env.agentId,
    signer,
    client,
    policy,
    jobs: jobStore,
    nonces,
    submissionMarginSec: env.submissionMarginSec,
    pollMs: env.pollMs,
  });

  logger.info(
    {
      agentId: env.agentId,
      agentAddress: signer.address,
      chainId: manifest.chainId,
      governor: addresses.governor,
      policy: `scripted:${env.policyDirective}`,
      pollMs: env.pollMs,
    },
    "worker starting",
  );

  const fromBlock = BigInt(manifest.deploymentBlock);
  const terminalIds = new Set<string>();

  let stopping = false;
  let currentTick: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    await workerTick({
      listProposalIds: (from) => listProposalIds(client, from),
      getProposalState: (id) => client.getProposalState(id),
      handleProposal: (id) => worker.handleProposal(id),
      fromBlock,
      terminalIds,
      onResult: (id, state, job) => {
        logger.info(
          {
            proposalId: id.toString(),
            proposalState: ProposalState[state],
            jobState: job?.state ?? null,
            lastError: job?.lastError ?? null,
          },
          "handled proposal",
        );
      },
      onError: (id, err) => {
        logger.error({ proposalId: id.toString(), error: explainRevert(err) }, "handleProposal failed");
      },
    });
  }

  function requestShutdown(signal: string): void {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutdown requested; finishing the poll in flight");
    void currentTick.finally(async () => {
      if (jobStore instanceof PgJobStore) await jobStore.close();
      if (nonceStore instanceof PgNonceStore) await nonceStore.close();
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
