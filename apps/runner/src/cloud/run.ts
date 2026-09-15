import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createDemoConfig } from "../lib/demo-config.js";
import { buildDeployConfig } from "../lib/deploy-config.js";
import { JsonFileUiRunStore } from "../lib/db.js";
import { buildRunState } from "../lib/run-state.js";
import { runExperiment } from "../pipeline/run-pipeline.js";
import { JsonFileRunStore } from "../pipeline/state.js";
import { runPath, type DemoRun, type DemoStatus } from "./control.js";
import { readObject, readSecret, writeObject } from "./google.js";
import { fundWallets } from "./wallets.js";
import { configureCloudReadside } from "./readside-config.js";
import { verifyActivity, type ActivityAttestation } from "../pipeline/activity-attestation.js";

const root = process.cwd();
const runId = process.argv[2] ?? "";
const statusPath = runPath(runId, "status.json");
const runDir = path.join(root, "experiments/reports", runId);
mkdirSync(runDir, { recursive: true });
const history: { at: string; message: string }[] = [];
let status: DemoStatus = { runId, phase: "worker-ready", message: "GCP worker is running.", terminal: false, updatedAt: new Date().toISOString(), history };
let sensitive: string[] = [];
const identities = new Map<number, string>();
const redact = (value: unknown) => {
  let json = JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
  for (const secret of sensitive) if (secret) json = json.split(secret).join("[redacted]");
  json = json.replace(/sk-or-v1-[a-zA-Z0-9]+|alch_[a-zA-Z0-9_-]+/g, "[redacted]");
  return JSON.parse(json);
};
let snapshotPending = false;
let publicContext: Record<string, unknown> | undefined;
async function snapshot() {
  if (snapshotPending) return;
  snapshotPending = true;
  try {
    if (existsSync(path.join(runDir, "run-state.json"))) {
      try {
        const view = await buildRunState(runId);
        status.view = view; status.viewUpdatedAt = new Date().toISOString();
        if (publicContext) {
          const deploymentFile = path.join(root, "deployments/agora-next-deployment.json");
          if (existsSync(deploymentFile)) {
            const governor = String(JSON.parse(readFileSync(deploymentFile, "utf8")).governor).toLowerCase();
            if (/^0x[0-9a-f]{40}$/.test(governor)) for (const proposal of view.proposals) {
              if (!/^[0-9]+$/.test(proposal.proposalId)) continue;
              const contextDir = path.join(root, "deployments/experiment-proposals", governor);
              mkdirSync(contextDir, { recursive: true });
              writeFileSync(path.join(contextDir, `${proposal.proposalId}.json`), JSON.stringify({ ...publicContext, governor, proposalId: proposal.proposalId }));
            }
          }
        }
      } catch { /* Keep the last successful view, explicitly timestamped. */ }
    }
    const activity: unknown[] = [];
    for (const file of ["steps.jsonl", "objections.jsonl", "loop-events.jsonl"]) {
      const full = path.join(runDir, file);
      if (!existsSync(full)) continue;
      for (const line of readFileSync(full, "utf8").trim().split("\n").slice(-50)) {
        try { activity.push(JSON.parse(line)); } catch { /* A currently appended line is retried next time. */ }
      }
    }
    status.activity = activity;
    const attestationsPath = path.join(runDir, "attestations.jsonl");
    if (existsSync(attestationsPath)) {
      const attestations = readFileSync(attestationsPath, "utf8").trim().split("\n").slice(-50);
      for (const line of attestations) {
        try {
          // Verify the exact record that will be shown. Redaction can invalidate a signature.
          const record = redact(JSON.parse(line)) as ActivityAttestation;
          if (record.runId !== runId || record.chainId !== 84532) continue;
          const signatureVerified = identities.get(record.agentId) === record.address.toLowerCase() && await verifyActivity(record);
          const event = record.event as { type?: string; why?: string; event?: { type: string } };
          activity.push({ type: "attestation", at: record.at, agentId: record.agentId, message: event.why ?? event.event?.type ?? event.type, signatureVerified, signedRecord: record });
        } catch { /* Incomplete records are retried on the next snapshot. */ }
      }
    }
    activity.sort((a, b) => String((a as { at?: string }).at ?? "").localeCompare(String((b as { at?: string }).at ?? "")));
    status.updatedAt = new Date().toISOString();
    await writeObject(statusPath, redact(status));
  } finally { snapshotPending = false; }
}
async function progress(phase: string, message: string) {
  status.phase = phase; status.message = message;
  history.push({ at: new Date().toISOString(), message });
  appendFileSync(path.join(runDir, "run.log"), `${new Date().toISOString()} ${message}\n`);
  await snapshot();
}
let timer: NodeJS.Timeout | undefined;
try {
  const request = await readObject<DemoRun>(runPath(runId, "request.json"));
  if (!request) throw new Error("Experiment request is missing.");
  await progress("worker-ready", "GCP worker accepted the experiment.");
  const keys = await fundWallets(request.settings.agentCount, message => progress("funding", message));
  const [rpcHttp, rpcWs] = await Promise.all([readSecret("fleet-base-sepolia-rpc-url"), readSecret("fleet-base-sepolia-ws-url")]);
  const modelKey = process.env.OPENROUTER_API_KEY;
  if (!modelKey) throw new Error("The pinned experiment inference credential is missing.");
  sensitive = [rpcHttp, rpcWs, modelKey, process.env.POSTGRES_PASSWORD ?? "", process.env.JWT_SECRET ?? "", ...Object.values(keys)];
  for (let id = 0; id < request.settings.agentCount; id++) identities.set(id, privateKeyToAccount(keys[`FLEET_AGENT_KEY_${id}`]!).address.toLowerCase());
  Object.assign(process.env, keys, { OPENROUTER_API_KEY: modelKey });
  configureCloudReadside(root, rpcHttp, rpcWs);
  const agoraUrl = process.env.FLEET_CONTROL_URL;
  if (!agoraUrl) throw new Error("The worker has no deployed experiment URL.");
  const generated = createDemoConfig(request.settings, { repoRoot: root, name: runId, rpcHttp, rpcWs, agoraUrl });
  status.constitution = generated.config.task.constitution;
  status.constitutionHash = generated.constitutionHash;
  status.revision = process.env.FLEET_REVISION ?? request.revision;
  publicContext = { runId, goal: request.settings.goal, constitution: generated.config.task.constitution, constitutionHash: generated.constitutionHash,
    agents: generated.config.fleet.members.map((member, id) => ({ agentId: id, role: member.role, model: member.model, address: identities.get(id) })) };
  const configDir = path.join(root, "experiments/configs"); mkdirSync(configDir, { recursive: true });
  const experimentPath = path.join(configDir, `${runId}.json`);
  if (!existsSync(experimentPath)) writeFileSync(experimentPath, JSON.stringify(generated.config, null, 2), { mode: 0o600 });
  const deployDir = path.join(root, "deployments/configs"); mkdirSync(deployDir, { recursive: true });
  const deployConfigPath = path.join(deployDir, `${runId}.deploy.json`);
  if (!existsSync(deployConfigPath)) writeFileSync(deployConfigPath, JSON.stringify(buildDeployConfig(generated.config, process.env, { chainId: 84532 }), null, 2), { mode: 0o600 });
  const uiStore = new JsonFileUiRunStore(path.join(root, "experiments/reports"));
  if (!(await uiStore.list()).some(row => row.runId === runId)) await uiStore.insert({ runId, experimentPath, deployConfigPath, logPath: path.join(runDir, "run.log"), pid: process.pid, readSide: true, createdAt: request.createdAt });
  await progress("preflight", "Wallets funded. Checking the chain, model budget and deployment inputs.");
  timer = setInterval(() => { void snapshot().catch(() => console.error("Progress upload failed; the worker will retry.")); }, 10_000);
  const diskStore = new JsonFileRunStore(runDir);
  const result = await runExperiment({
    runId, experimentPath, fixturesDir: path.join(root, "experiments/fixtures"), repoRoot: root,
    contractsDir: path.join(root, "contracts"), configDir: deployDir, infraDir: path.join(root, "infra"),
    abiSourceDir: path.join(root, "packages/abi/abis"), deploymentsDir: path.join(root, "deployments"), reportDir: path.join(root, "experiments/reports"),
    readSide: true, bootstrapReadSide: true,
    store: { get: id => diskStore.get(id), save: async record => { await diskStore.save(record); await progress(record.stage.toLowerCase().replaceAll("_", "-"), `Completed ${record.stage.toLowerCase().replaceAll("_", " ")}.`); } },
    log: message => { appendFileSync(path.join(runDir, "run.log"), `${redact(message)}\n`); },
  });
  status.terminal = true;
  status.outcome = result.result?.pass ? "Run captured. Inspect the votes and execution evidence below." : "Run finished with failed checks. Inspect the report before rerunning.";
  await progress(result.result?.pass ? "complete" : "failed", "Experiment finished. Its configuration and evidence are preserved.");
} catch (error) {
  status.terminal = true;
  const message = error instanceof Error ? error.message : "Unknown worker failure.";
  await progress("failed", /https?:|alch_|sk-|Bearer/.test(message) ? "Worker failed. Credential-bearing provider details were withheld." : message);
  process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  // Do not exit while an earlier snapshot can overwrite terminal status.
  while (snapshotPending) await new Promise(resolve => setTimeout(resolve, 100));
  const evidence: Record<string, unknown> = {};
  for (const file of ["record.json", "report.md", "attestations.jsonl"]) {
    if (existsSync(path.join(runDir, file))) evidence[file] = readFileSync(path.join(runDir, file), "utf8");
  }
  await writeObject(runPath(runId, "evidence.json"), redact(evidence));
  await snapshot();
}
