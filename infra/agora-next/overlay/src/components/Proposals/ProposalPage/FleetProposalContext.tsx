import { readFileSync } from "fs";
import path from "path";
import Tenant from "@/lib/tenant/tenant";
import { loadFleetDeployment } from "@/lib/tenant/configs/contracts/fleet";

type ExperimentContext = {
  runId: string; goal: string; constitutionHash: string;
  constitution: { title: string; text: string };
  agents: { agentId: number; role: string; model: string; address: string }[];
};

export default function FleetProposalContext({ proposalId }: { proposalId: string }) {
  if (Tenant.current().namespace !== "fleet" || !/^[0-9]+$/.test(proposalId)) return null;
  let context: ExperimentContext;
  try {
    const deployment = loadFleetDeployment();
    const directory = path.dirname(process.env.FLEET_DEPLOYMENT_FILE || "/deployments/agora-next-deployment.json");
    if (!/^0x[0-9a-fA-F]{40}$/.test(deployment.governor)) return null;
    context = JSON.parse(readFileSync(path.join(directory, "experiment-proposals", deployment.governor.toLowerCase(), `${proposalId}.json`), "utf8"));
    if (!/^run-[0-9a-f-]{36}$/.test(context.runId)) return null;
  } catch { return null; }
  return <section className="mb-8 p-6 rounded-xl border border-line bg-wash space-y-4 max-w-4xl">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold text-primary">The experiment behind this vote</h2><a className="underline text-sm" href={`/experiments/${context.runId}`}>Open run and activity timeline →</a></div>
    <p className="text-primary">{context.goal}</p>
    <p className="text-sm text-secondary">Each agent reviews the proposed action against the task and constitution, then submits its own ballot and public reason. The vote list below comes from Agora's indexed Base Sepolia records. Approval must settle before the executor can carry out the exact protected action.</p>
    <div className="grid sm:grid-cols-2 gap-3">{context.agents.map(agent => <div key={agent.agentId} className="text-sm"><p className="font-medium">Agent {agent.agentId} · {agent.role}</p><p className="text-secondary">{agent.model}</p><code className="text-xs break-all">{agent.address}</code></div>)}</div>
    <details className="text-sm"><summary className="cursor-pointer font-medium">{context.constitution.title}</summary><p className="whitespace-pre-wrap mt-3">{context.constitution.text}</p><code className="block mt-3 text-xs break-all">{context.constitutionHash}</code></details>
    <p className="text-sm"><a className="underline" href="/info">How this works</a> · <a className="underline" href="/experiments">Start another experiment</a></p>
  </section>;
}
