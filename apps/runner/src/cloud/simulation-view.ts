import { readFileSync } from "node:fs";
import { BUCKET, googleRequest, readObject } from "./google.js";
import { readComputeAllocation, readComputeAllocationById, readComputeState, readComputeEvidence } from "./compute-store.js";
import { readSimulationRequest, readSimulationWork, simulationPath } from "./simulation.js";
import { verifyActivity, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { publicSnapshot } from "./site-access.js";

export const agentRoster = JSON.parse(readFileSync("experiments/compute/agent-roster.json", "utf8")) as { agentId: number; name: string; address: string; role: string }[];
const runPattern = /^run-[0-9a-f-]{36}$/;
type Status = { runId: string; updatedAt?: string; createdAt?: string; phase?: string; proposalId?: string; activity?: ActivityAttestation[] };
let historyCache: { until: number; runs: Status[] } | undefined;
export async function simulationHistory(): Promise<Status[]> {
  if (historyCache && historyCache.until > Date.now()) return historyCache.runs;
  const listing = await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o?prefix=demo%2Fsimulations%2F&matchGlob=**%2Fstatus.json&maxResults=1000`)).json() as { items?: { name: string; updated: string }[] };
  const names = (listing.items ?? []).filter(x => /^demo\/simulations\/run-[0-9a-f-]{36}\/status.json$/.test(x.name)).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 50);
  const runs: Status[] = [];
  for (let i = 0; i < names.length; i += 5) {
    for (const value of await Promise.all(names.slice(i, i + 5).map(x => readObject<Status>(x.name)))) {
      if (value && runPattern.test(value.runId)) runs.push({ runId: value.runId, ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}), ...(value.phase ? { phase: value.phase } : {}), ...(value.proposalId ? { proposalId: value.proposalId } : {}) });
    }
  }
  historyCache = { until: Date.now() + 15_000, runs };
  return runs;
}

const activityCache = new Map<string, { revision: string; records: unknown[] }>();
async function verifiedActivity(status: Status | null, runId: string, taskId?: string) {
  // Verify the bytes viewers receive. Redaction must not leave a "verified" badge
  // attached to a different payload from the one the agent signed.
  const records = (Array.isArray(status?.activity) ? status.activity.filter(record => record && typeof record === "object").slice(-100) : [])
    .map(record => publicSnapshot(record) as ActivityAttestation);
  const revision = JSON.stringify({ taskId, records });
  if (activityCache.get(runId)?.revision === revision) return activityCache.get(runId)!.records;
  const verified = await Promise.all(records.map(async record => ({ ...record, signatureVerified:
    record.runId === runId && record.taskId === taskId && record.chainId === 84532 &&
    agentRoster.some(agent => agent.agentId === record.agentId && typeof record.address === "string" && agent.address.toLowerCase() === record.address.toLowerCase()) && await verifyActivity(record) })));
  if (activityCache.size > 50) activityCache.clear();
  activityCache.set(runId, { revision, records: verified });
  return verified;
}

export async function simulationSnapshot(selectedRun?: string) {
  if (selectedRun && !runPattern.test(selectedRun)) throw new Error("Invalid run identity.");
  const [active, request, evidence] = await Promise.all([readComputeAllocation(), readSimulationRequest(), readComputeEvidence()]);
  const runId = selectedRun ?? request?.runId ?? active?.runId;
  const isCurrentRun = !selectedRun || selectedRun === request?.runId || selectedRun === active?.runId;
  const [status, work] = runId ? await Promise.all([readObject<Status>(simulationPath(runId)), readSimulationWork(runId)]) : [null, null];
  const allocation = isCurrentRun ? active : work ? await readComputeAllocationById(work.allocationId) : null;
  if (!isCurrentRun && allocation && allocation.runId !== runId) throw new Error("Saved allocation belongs to another run.");
  const state = allocation ? (await readComputeState(allocation.allocationId))?.value ?? null : null;
  let vm: { id?: string; status: string; machineType?: string };
  if (isCurrentRun) {
    const observed = await (await googleRequest("compute", "compute/v1/projects/fleet-governance/zones/us-central1-a/instances/fleet-research")).json() as { id: string; status: string; machineType: string };
    vm = { id: observed.id, status: observed.status, machineType: observed.machineType.split("/").pop()! };
  } else vm = { status: state?.observedVmStatus ?? "UNKNOWN" };
  const replay = selectedRun && (evidence as { allocationId?: string } | null)?.allocationId !== allocation?.allocationId ? null : evidence;
  return { simulation: isCurrentRun ? request : work || status ? { runId, createdAt: work?.createdAt ?? status?.createdAt ?? status?.updatedAt } : null,
    simulationStatus: status, simulationWork: work, allocation, state, vm, evidence: replay, agentRoster,
    activity: runId ? await verifiedActivity(status, runId, work?.taskId) : [], isCurrentRun,
    observedAt: new Date().toISOString() };
}

export async function simulationProposal(proposalId: string) {
  const run = (await simulationHistory()).find(run => run.proposalId === proposalId);
  if (!run) return null;
  const work = await readSimulationWork(run.runId);
  return work?.proposalId === proposalId ? { ...work, agents: agentRoster } : null;
}
