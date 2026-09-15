import { writeFileSync } from "node:fs";
import path from "node:path";

export function configureCloudReadside(root: string, rpcHttp: string, rpcWs: string): void {
  const env = process.env;
  for (const name of ["FLEET_DAO_IMAGE", "FLEET_CPLS_IMAGE", "FLEET_AGORA_IMAGE"]) {
    if (!/^us-central1-docker\.pkg\.dev\/fleet-governance\/fleet\/[a-z-]+@sha256:[a-f0-9]{64}$/.test(env[name] ?? "")) throw new Error(`Missing pinned read-side image: ${name}.`);
  }
  if (!env.POSTGRES_PASSWORD || !env.JWT_SECRET) throw new Error("Read-side application secrets are missing.");
  const values = {
    FLEET_GCP_READSIDE: "1", GCS_USE_ADC: "1", CHAIN_ID: "84532", CONTRACT_DEPLOYMENT: "sepolia",
    DAO_NODE_ARCHIVE_NODE_HTTP: rpcHttp, DAO_NODE_REALTIME_NODE_WS: rpcWs,
    DAO_NODE_ARCHIVE_NODE_HTTP_BLOCK_COUNT_SPAN: "10", NUM_POLLING_CLIENTS: "1",
    ANVIL_RPC_URL: rpcHttp, FLEET_RPC_HTTP: rpcHttp,
    POSTGRES_USER: "agora", POSTGRES_PASSWORD: env.POSTGRES_PASSWORD,
    POSTGRES_PORT: "55432", DAO_NODE_PORT: "8000", CPLS_PORT: "8001", AGORA_NEXT_PORT: "3000",
    DATABASE_URL: `postgres://agora:${encodeURIComponent(env.POSTGRES_PASSWORD)}@127.0.0.1:55432/agora_web3`,
    GCS_BUCKET_NAME: "fleet-governance-archive-449245570324", JWT_SECRET: env.JWT_SECRET,
    FLEET_DAO_IMAGE: env.FLEET_DAO_IMAGE!, FLEET_CPLS_IMAGE: env.FLEET_CPLS_IMAGE!, FLEET_AGORA_IMAGE: env.FLEET_AGORA_IMAGE!,
    FLEET_CONTROL_URL: env.FLEET_CONTROL_URL!,
  };
  for (const value of Object.values(values)) if (!value || /[\r\n\0']/.test(value)) throw new Error("Invalid cloud read-side setting.");
  writeFileSync(path.join(root, "infra/.env"), Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n") + "\n", { mode: 0o600 });
}
