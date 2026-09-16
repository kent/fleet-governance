import { readFileSync } from "node:fs";
import { BUCKET, googleRequest, readObject } from "./google.js";
import { readComputeAllocation, readComputeAllocationById, readComputeState, readComputeEvidence } from "./compute-store.js";
import { readRecordedSimulationRequest, readSimulationWork, simulationPath } from "./simulation.js";
import { verifyActivity, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { publicSnapshot } from "./site-access.js";
import type { RunEvent } from "./run-events.js";

export const agentRoster = JSON.parse(readFileSync("experiments/compute/agent-roster.json", "utf8")) as { agentId: number; name: string; address: string; role: string }[];
const runPattern = /^run-[0-9a-f-]{36}$/;
type Status = { runId: string; updatedAt?: string; createdAt?: string; phase?: string; proposalId?: string; activity?: ActivityAttestation[];
  events?: RunEvent[]; rounds?: { proposalId: string; txHash?: string; phase: string; proposalBody?: string; title?: string; proposerAgentId?: number; creditTxHash?: string; checkpoint?: number }[]; proposalIds?: string[] };
let historyCache: { until: number; runs: Status[] } | undefined;
async function readSimulationHistory(): Promise<Status[]> {
  if (historyCache && historyCache.until > Date.now()) return historyCache.runs;
  const listing = await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o?prefix=demo%2Fsimulations%2F&matchGlob=**%2Fstatus.json&maxResults=1000`)).json() as { items?: { name: string; updated: string }[] };
  const names = (listing.items ?? []).filter(x => /^demo\/simulations\/run-[0-9a-f-]{36}\/status.json$/.test(x.name)).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, 50);
  const runs: Status[] = [];
  for (let i = 0; i < names.length; i += 5) {
    for (const value of await Promise.all(names.slice(i, i + 5).map(x => readObject<Status>(x.name)))) {
      if (value && runPattern.test(value.runId)) runs.push({ runId: value.runId, ...(value.updatedAt ? { updatedAt: value.updatedAt } : {}), ...(value.phase ? { phase: value.phase } : {}), ...(value.proposalId ? { proposalId: value.proposalId } : {}),
        proposalIds: value.rounds ? value.rounds.filter(round => round.txHash).map(round => round.proposalId) : value.proposalId ? [value.proposalId] : [] });
    }
  }
  historyCache = { until: Date.now() + 15_000, runs };
  return runs;
}

const activityCache = new Map<string, boolean>();
async function verifiedActivity(status: Status | null, runId: string, taskId?: string) {
  // Verify the bytes viewers receive. Redaction must not leave a "verified" badge
  // attached to a different payload from the one the agent signed.
  const records = (Array.isArray(status?.activity) ? status.activity.filter(record => record && typeof record === "object").slice(0, 1000) : [])
    .map(record => publicSnapshot(record) as ActivityAttestation);
  if (activityCache.size > 5000) activityCache.clear();
  return Promise.all(records.map(async record => {
    // Cache the complete redacted payload, signature and identity context. A digest
    // supplied by the worker alone must never confer a cached verification badge.
    const revision = JSON.stringify({ runId, taskId, roster: agentRoster, record });
    let verified = activityCache.get(revision);
    if (verified === undefined) {
      verified = record.runId === runId && record.taskId === taskId && record.chainId === 84532 &&
        agentRoster.some(agent => agent.agentId === record.agentId && typeof record.address === "string" && agent.address.toLowerCase() === record.address.toLowerCase()) && await verifyActivity(record);
      activityCache.set(revision, verified);
    }
    return { ...record, signatureVerified: verified };
  }));
}

export async function simulationSnapshot(selectedRun?: string) {
  if (selectedRun && !runPattern.test(selectedRun)) throw new Error("Invalid run identity.");
  const [active, request, evidence] = await Promise.all([readComputeAllocation(), readRecordedSimulationRequest(), readComputeEvidence()]);
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
  const preparing = runId && !work ? await readObject<{ events?: RunEvent[] }>(simulationPath(runId, "preparation.json")) : null;
  const sourceEvents = (values: RunEvent[] | undefined, source: string) => (Array.isArray(values) ? values : [])
    .filter(event => event && event.runId === runId).slice(0, 1000).map(event => ({ ...event, source }));
  const events = [
    ...sourceEvents(work?.preparationEvents ?? preparing?.events, work ? "Protected preparation record" : "Preparation service report"),
    ...sourceEvents(status?.events, "Worker report · inspect the supporting evidence"),
  ];
  return { simulation: isCurrentRun ? request : work || status ? { runId, createdAt: work?.createdAt ?? status?.createdAt ?? status?.updatedAt } : null,
    simulationStatus: status, simulationWork: work, allocation, state, vm, evidence: replay, agentRoster, events,
    activity: runId ? await verifiedActivity(status, runId, work?.taskId) : [], isCurrentRun,
    observedAt: new Date().toISOString() };
}

export async function simulationProposal(proposalId: string) {
  const run = (await simulationHistory()).find(run => run.proposalIds?.includes(proposalId));
  if (!run) return null;
  const work = await readSimulationWork(run.runId);
  if (work?.agentDriven) {
    const status = await readObject<Status>(simulationPath(run.runId));
    const proposal = status?.rounds?.find(round => round.proposalId === proposalId && round.txHash);
    return proposal ? { ...work, ...proposal, proposalTitle: proposal.title, checkpointIndex: proposal.checkpoint,
      proposalOrigin: "agent", agents: agentRoster.slice(0, work.settings?.agentCount ?? 5) } : null;
  }
  const checkpoint = work?.checkpoints?.find(item => item.proposalId === proposalId);
  return checkpoint ? { ...work, ...checkpoint, checkpointIndex: work!.checkpoints!.indexOf(checkpoint), agents: agentRoster }
    : work?.proposalId === proposalId ? { ...work, agents: agentRoster } : null;
}

// Public display only. Never use this cache to authorise execution. Concurrent
// viewers share one observation; its original observedAt is retained on cache hits.
export function coalescedReader<T>(read: (key?: string) => Promise<T>, ttlMs: number, maxEntries = 50) {
  const cache = new Map<string, { until: number; pending: Promise<T> }>();
  return (key?: string): Promise<T> => {
    const id = key ?? "current", hit = cache.get(id);
    if (hit && hit.until > Date.now()) return hit.pending;
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    const entry = { until: Infinity, pending: Promise.resolve().then(() => read(key)) };
    cache.set(id, entry);
    entry.pending.then(() => { entry.until = Date.now() + ttlMs; }, () => { if (cache.get(id) === entry) cache.delete(id); });
    return entry.pending;
  };
}
export const cachedSimulationSnapshot = coalescedReader(simulationSnapshot, 4000);
export const simulationHistory = coalescedReader(readSimulationHistory, 15000);
