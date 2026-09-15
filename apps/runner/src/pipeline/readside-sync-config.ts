import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { readEnvValue } from "../readside.js";
import type { ReadSideSyncConfig } from "./fixture-runner.js";

/**
 * Builds the `ReadSideSyncConfig` `runFixture` needs to sync the read side after every governance
 * transaction (task 8 finding 3), reading connection details out of `infra/.env` the same way
 * `readside.ts` itself does. `votesPool` connects to the `agora_web3` database (fixed name; see
 * `infra/docker-compose.yml`'s `DATABASE_URL`s), CPLS's own vote source. Caller owns the returned
 * pool's lifetime (`close()`).
 */
export function buildReadSideSyncConfig(infraDir: string): { config: ReadSideSyncConfig; close: () => Promise<void> } {
  const envPath = path.join(infraDir, ".env");
  const envText = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

  const postgresPort = readEnvValue(envText, "POSTGRES_PORT", "55432");
  const postgresUser = readEnvValue(envText, "POSTGRES_USER", "agora");
  const postgresPassword = readEnvValue(envText, "POSTGRES_PASSWORD", "agora");
  const daoNodePort = readEnvValue(envText, "DAO_NODE_PORT", "8000");
  const cplsPort = readEnvValue(envText, "CPLS_PORT", "8001");
  const fakeGcsPort = readEnvValue(envText, "FAKE_GCS_PORT", "4443");
  const bucketName = readEnvValue(envText, "GCS_BUCKET_NAME", "fleet-archive-dev");
  const offline = readEnvValue(envText, "GCS_CREDENTIALS_FILE", "") === "" && readEnvValue(envText, "GCS_USE_ADC", "") !== "1";

  const votesPool = new pg.Pool({
    connectionString: `postgres://${encodeURIComponent(postgresUser)}:${encodeURIComponent(postgresPassword)}@localhost:${postgresPort}/agora_web3`,
  });

  const config: ReadSideSyncConfig = {
    votesPool,
    daoNodeUrl: `http://localhost:${daoNodePort}`,
    cplsUrl: `http://localhost:${cplsPort}`,
    offline,
    bucketName,
    ...(offline ? { fakeGcsUrl: `http://localhost:${fakeGcsPort}` } : {}),
    ...(readEnvValue(envText, "FLEET_GCP_READSIDE", "") === "1" ? { archiveBaseUrl: `http://127.0.0.1:8082/${bucketName}` } : {}),
  };

  return { config, close: () => votesPool.end() };
}
