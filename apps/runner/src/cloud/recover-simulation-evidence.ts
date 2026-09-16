import { writeFileSync } from "node:fs";
import { BUCKET, googleRequest, readObjectVersion, writeObject } from "./google.js";
import { readSimulationWork, simulationPath } from "./simulation.js";
import { verifyActivity, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { agentRoster } from "./simulation-view.js";
import { writeControlObject } from "./compute-admin.js";

// Explicit CI repair of a failed display record. This neither clears authority
// nor restarts work. Preserve its source generation and a protected repair audit.
try {
  const { runId } = JSON.parse(process.env.COMPUTE_REQUEST || "{}");
  const name = simulationPath(runId);
  const [current, work] = await Promise.all([readObjectVersion<Record<string, any>>(name), readSimulationWork(runId)]);
  if (!work || !current || current.value.runId !== runId || current.value.phase !== "failed" || current.value.terminal !== true)
    throw new Error("Only a failed simulation record can be repaired.");
  const response = await googleRequest("storage", `storage/v1/b/${BUCKET}/o?prefix=${encodeURIComponent(name)}&versions=true&maxResults=1000`);
  const listing = await response.json() as { items?: { name: string; generation: string }[]; nextPageToken?: string };
  if (listing.nextPageToken) throw new Error("Version history requires a separate review.");
  const versions = (listing.items ?? []).filter(item => item.name === name && /^[0-9]+$/.test(item.generation)
    && BigInt(item.generation) < BigInt(current.generation)).sort((a, b) => BigInt(a.generation) > BigInt(b.generation) ? -1 : 1);
  let recovered = false;
  for (const version of versions) {
    const saved = await (await googleRequest("storage", `storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media&generation=${version.generation}`)).json() as Record<string, any>;
    if (saved.runId !== runId || saved.allocationId !== work.allocationId || !saved.activity?.length || !saved.rounds?.length) continue;
    for (const record of saved.activity as ActivityAttestation[]) {
      if (record.runId !== runId || record.taskId !== work.taskId || record.chainId !== 84532
        || !agentRoster.some(agent => agent.agentId === record.agentId && agent.address.toLowerCase() === record.address.toLowerCase())
        || !await verifyActivity(record)) throw new Error("Saved activity identity is invalid.");
    }
    const audit = { runId, sourceGeneration: version.generation, replacedGeneration: current.generation,
      recordedThrough: saved.updatedAt, recoveredAt: new Date().toISOString(), workflowRun: process.env.GITHUB_RUN_ID };
    const repaired = { ...saved, terminal: true, phase: "failed", updatedAt: audit.recoveredAt, evidenceRecovery: audit,
      message: "This run failed before completing its decisions. Recorded activity was recovered from a previous storage version. No work was restarted; the original halt and deadlines remain in force." };
    await writeControlObject(`evidence/recovered-${runId}-${current.generation}.json`, { audit, overwrittenStatus: current.value });
    await writeObject(name, repaired, current.generation);
    writeFileSync("recovered-simulation-evidence.json", JSON.stringify(repaired, null, 2));
    console.log(JSON.stringify({ event: "failed_run_evidence_recovered", ...audit, signedRecords: saved.activity.length,
      rounds: saved.rounds.map((round: any) => ({ proposalId: round.proposalId, votes: round.votes?.length, phase: round.phase })) }));
    recovered = true; break;
  }
  if (!recovered) throw new Error("No prior signed activity record was found.");
} catch {
  console.error("Evidence repair did not complete. No compute authority was changed. Private diagnostics withheld.");
  process.exitCode = 1;
}
