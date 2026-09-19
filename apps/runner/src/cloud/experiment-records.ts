import { BUCKET, googleRequest, readObject } from "./google.js";
import { readComputeObject } from "./compute-store.js";
import { readSimulationWork, simulationPath, type SimulationRequest } from "./simulation.js";
import { runPath, RUN_ID, type DemoRun } from "./control.js";
import { coalescedReader } from "./simulation-view.js";

/** The question a reader opens the index with: did the fleet vote this compute off?
 * Derived only from published proposals and their recorded ballots, so a run that
 * stopped without a decision is never reported as one. */
export function runOutcome(phase: string, terminal: boolean, rounds: any[] = []) {
  const published = rounds.filter(round => round.txHash);
  const ballots = published.reduce((sum, round) => sum + (round.votes?.length ?? 0), 0);
  const against = published.reduce((sum, round) => sum + (round.votes ?? []).filter((vote: any) => vote.directive === "AGAINST").length, 0);
  const rejected = published.some(round => ["denied", "defeated", "rejected"].includes(round.phase));
  if (!terminal && phase === "voting") return { code: "voting", label: "Vote open", note: "Waiting on ballots" };
  if (!terminal) return { code: "running", label: "Running", note: "No result yet" };
  if (["preparation-failed", "recovered"].includes(phase)) return { code: "incomplete", label: "No proposal", note: "Run did not reach a vote" };
  if (rejected && against > 0) return { code: "voted-down", label: "Fleet voted it down", note: `${against} AGAINST · compute stopped` };
  if (rejected && ballots === 0) return { code: "no-ballots", label: "Nobody voted", note: "Deadline stopped the compute" };
  if (phase === "failed") return { code: "incomplete", label: "Did not finish", note: ballots ? `${ballots} ballots recorded` : "No ballots recorded" };
  if (published.length && !rejected) return { code: "approved", label: "Fleet approved everything", note: `${ballots} ballots · clock stopped the compute` };
  return { code: "incomplete", label: "No proposal", note: "The agents never asked for a vote" };
}

/** One experiment is one immutable request and its resulting evidence. Legacy
 * records stay distinct; later defaults must never rewrite their settings. */
export async function experimentRecord(id: string) {
  if (!RUN_ID.test(id)) throw new Error("Invalid experiment identity.");
  const [protectedRequest, request, work, simulationStatus, legacy] = await Promise.all([
    readComputeObject(`simulations/${id}/request.json`) as Promise<SimulationRequest | null>,
    readObject<SimulationRequest>(simulationPath(id, "request.json")), readSimulationWork(id),
    readObject<Record<string, any>>(simulationPath(id)), readObject<DemoRun>(runPath(id, "request.json")),
  ]);
  if (protectedRequest || request || work || simulationStatus) {
    const saved = protectedRequest ?? request;
    const settings = work?.settings ?? protectedRequest?.settings ?? request?.settings ?? simulationStatus?.settings ?? null;
    const rounds = simulationStatus?.rounds ?? [];
    const experiment = { id, runId: id, name: settings?.name ?? (work?.checkpoints ? "Recorded checkpoint experiment" : work?.agentDriven ? "Agent-authored governance" : "Recorded compute experiment"),
      kind: "governed", scenario: work?.scenario ?? saved?.scenario ?? "legacy-compute", settings,
      goal: settings?.goal ?? work?.goal ?? simulationStatus?.goal ?? "Recorded governance run",
      agentCount: settings?.agentCount ?? 5, createdAt: saved?.createdAt ?? work?.createdAt ?? simulationStatus?.createdAt ?? simulationStatus?.updatedAt,
      phase: simulationStatus?.phase ?? "queued", terminal: simulationStatus?.terminal ?? false,
      outcome: runOutcome(simulationStatus?.phase ?? "queued", simulationStatus?.terminal ?? false, rounds),
      proposals: rounds.filter((r: any) => r.txHash).length || (work?.proposeTxHash ? 1 : 0),
      ballots: rounds.reduce((sum: number, r: any) => sum + (r.votes?.length ?? 0), 0) || simulationStatus?.votes?.length || 0,
      delegations: (simulationStatus?.events ?? []).filter((e: any) => e.type === "delegation.confirmed").length,
      chargedCostUsd: simulationStatus?.inference?.budget?.chargedCostUsd ?? null,
      proposalToken: work?.agentDriven?.proposalToken ?? null,
      proposalBonds: work?.agentDriven?.proposalBonds ?? null,
      configurationSource: protectedRequest || work ? "Protected operator record" : "Queued request record",
      url: `/experiments/${id}`, evidenceUrl: `/api/experiments/${id}/evidence` };
    return { experiment, run: { runId: id, createdAt: experiment.createdAt, settings }, status: simulationStatus };
  }
  if (!legacy) return null;
  const status = await readObject<Record<string, any>>(runPath(id, "status.json"));
  return { experiment: { id, runId: id, name: "Recorded task experiment", kind: "general", scenario: "legacy-task", settings: legacy.settings,
    goal: legacy.settings.goal, agentCount: legacy.settings.agentCount, createdAt: legacy.createdAt, phase: status?.phase ?? "queued",
    terminal: status?.terminal ?? false, outcome: runOutcome(status?.phase ?? "queued", status?.terminal ?? false, []),
    proposals: status?.view?.proposals?.length ?? 0,
    ballots: (status?.view?.proposals ?? []).reduce((sum: number, p: any) => sum + (p.votes?.length ?? 0), 0), delegations: null,
    chargedCostUsd: status?.inference?.budget?.chargedCostUsd ?? null, configurationSource: "Historical task record",
    url: `/experiments/${id}`, evidenceUrl: `/api/experiments/${id}/evidence` }, run: legacy, status };
}

async function readIndex() {
  const ids = new Set<string>();
  for (const prefix of ["demo/simulations/", "demo/runs/"]) {
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ prefix, maxResults: "1000" });
      if (token) params.set("pageToken", token);
      const page = await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o?${params}`)).json() as { items?: { name: string }[]; nextPageToken?: string };
      for (const item of page.items ?? []) {
        if (!/\/(request|status)\.json$/.test(item.name)) continue;
        const id = item.name.split("/")[2]; if (id && RUN_ID.test(id)) ids.add(id);
      }
      token = page.nextPageToken;
    } while (token);
  }
  const experiments = [];
  const ordered = [...ids];
  for (let i = 0; i < ordered.length; i += 5) {
    for (const record of await Promise.all(ordered.slice(i, i + 5).map(experimentRecord))) if (record) experiments.push(record.experiment);
  }
  return experiments.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}
export const experimentIndex = coalescedReader(readIndex, 15000, 1);
