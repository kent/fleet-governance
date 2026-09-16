import { readFileSync } from "fs";
import path from "path";
import { fleetAgentName } from "@/lib/fleetAgents";
import Tenant from "@/lib/tenant/tenant";
import { loadFleetDeployment } from "@/lib/tenant/configs/contracts/fleet";

type ExperimentContext = {
  runId: string; goal: string; constitutionHash?: string;
  constitution: { title: string; text: string };
  checkpointIndex?: number; checkpointCount?: number; proposerAgentId?: number; creditTxHash?: string; proposalCost?: number; proposalThreshold?: number; proposalCredits?: number; proposalToken?: string; proposalBonds?: string; proposalBond?: number; bondSettlement?: string; bondParticipationPercent?: number;
  agents: { agentId: number; role: string; model?: string; address: string }[];
};

export default async function FleetProposalContext({ proposalId }: { proposalId: string }) {
  if (Tenant.current().namespace !== "fleet" || !/^[0-9]+$/.test(proposalId)) return null;
  let context: ExperimentContext;
  try {
    const deployment = loadFleetDeployment();
    const directory = path.dirname(process.env.FLEET_DEPLOYMENT_FILE || "/deployments/agora-next-deployment.json");
    if (!/^0x[0-9a-fA-F]{40}$/.test(deployment.governor)) return null;
    context = JSON.parse(readFileSync(path.join(directory, "experiment-proposals", deployment.governor.toLowerCase(), `${proposalId}.json`), "utf8"));
    if (!/^run-[0-9a-f-]{36}$/.test(context.runId)) return null;
  } catch {
    try {
      const response = await fetch(`https://fleet-governance-449245570324.us-central1.run.app/api/simulation-proposals/${proposalId}`, {
        next: { revalidate: 15 }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const work = await response.json();
      if (!/^run-[0-9a-f-]{36}$/.test(work.runId) || !Array.isArray(work.agents) || typeof work.constitution !== "string") return null;
      context = { runId: work.runId, goal: work.goal, agents: work.agents,
        ...(Number.isInteger(work.checkpointIndex) && Array.isArray(work.checkpoints) ? { checkpointIndex: work.checkpointIndex, checkpointCount: work.checkpoints.length } : {}),
        ...(work.proposalOrigin === "agent" && Number.isInteger(work.proposerAgentId) ? { proposalBonds: work.agentDriven?.proposalBonds, proposalBond: work.settings?.proposalBond, bondSettlement: work.bondSettlement, bondParticipationPercent: work.settings?.bondParticipationPercent, proposalToken: work.agentDriven?.proposalToken, proposerAgentId: work.proposerAgentId, proposalCost: work.settings?.proposalCost || 1, proposalCredits: work.settings?.proposalCredits || 3, proposalThreshold: work.settings?.proposalThreshold || 1,
          ...(/^0x[0-9a-fA-F]{64}$/.test(work.creditTxHash || "") ? { creditTxHash: work.creditTxHash } : {}) } : {}),
        constitution: { title: "This run's constitution", text: work.constitution } };
    } catch { return null; }
  }
  return <section className="mb-8 p-6 rounded-xl border border-line bg-wash space-y-4 max-w-4xl">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold text-primary">The experiment behind this vote</h2><a className="underline text-sm" href={`/experiments/${context.runId}#activity-log`}>Open run and activity timeline →</a></div>
    {context.checkpointIndex !== undefined && <p className="text-sm font-medium">Decision {context.checkpointIndex + 1} of {context.checkpointCount}. Approval releases this step only. A failed required vote stops the agent VM; another vote cannot restart it.</p>}
    {context.proposerAgentId !== undefined && context.proposalBonds && <p className="text-sm font-medium">Agent{context.proposerAgentId + 1} wrote this proposal during its investigation and reserved {context.proposalBond} FleetGov. The same token carries its votes. The bond returns when {context.bondParticipationPercent}% of the fixed supply participates, counting FOR, AGAINST and ABSTAIN, even if the proposal loses. Cancellation or insufficient participation forfeits it. {context.bondSettlement && <>Recorded settlement: {context.bondSettlement}. </>}{context.creditTxHash && <a className="underline" href={`https://sepolia.basescan.org/tx/${context.creditTxHash}`}>Inspect the onchain bond reservation ↗</a>}</p>}
    {context.proposerAgentId !== undefined && !context.proposalBonds && <p className="text-sm font-medium">Agent{context.proposerAgentId + 1} wrote this proposal during its investigation. Submitting cost {context.proposalCost} of its {context.proposalCredits} {context.proposalToken ? "ERC-20 FPROP tokens" : "proposal credits"} and required {context.proposalThreshold} voting units, including received delegations. The proposal fee is not refunded after defeat or cancellation. Voting rights remain unchanged. {context.creditTxHash && <a className="underline" href={`https://sepolia.basescan.org/tx/${context.creditTxHash}`}>Inspect the proposal fee ↗</a>}</p>}
    <p className="text-primary">{context.goal}</p>
    <p className="text-sm text-secondary">Each agent reviews the proposed action against the task and constitution, then submits its own ballot and public reason. The vote list below comes from Agora's indexed Base Sepolia records. A separate Guardian checks the required vote and stops the agent VM if approval fails. Agora and the vote archive stay online.</p>
    <div className="grid sm:grid-cols-2 gap-3">{context.agents.map(agent => <div key={agent.agentId} className="text-sm"><p className="font-medium"><a className="underline" href={`/experiments/${context.runId}#agent-${agent.agentId}`}>{fleetAgentName(agent.address) || `Agent${agent.agentId + 1}`}</a> · {agent.role}</p><p className="text-secondary">{agent.model}</p><a className="underline text-xs break-all" href={`/delegates/${agent.address}`}>{agent.address}</a></div>)}</div>
    <details className="text-sm"><summary className="cursor-pointer font-medium">{context.constitution.title}</summary><p className="whitespace-pre-wrap mt-3">{context.constitution.text}</p>{context.constitutionHash && <code className="block mt-3 text-xs break-all">{context.constitutionHash}</code>}</details>
    <p className="text-sm"><a className="underline" href="/info">How this works</a> · <a className="underline" href="/delegates">Agents and delegations</a> · <a className="underline" href="/experiments/new">Create another experiment</a></p>
  </section>;
}
