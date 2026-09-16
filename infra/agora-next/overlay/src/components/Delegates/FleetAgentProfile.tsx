import Link from "next/link";
import { formatUnits } from "viem";
import { getDaoNodeURLForNamespace } from "@/app/lib/dao-node/client";
import { fetchProposalFromArchive } from "@/lib/archiveUtils";
import { fleetAgentName } from "@/lib/fleetAgents";
import { fleetProfileVotes, fleetPublicReason } from "@/lib/fleetProfile";

const addressPattern = /^0x[0-9a-f]{40}$/;
async function indexed(path: string) {
  const base = getDaoNodeURLForNamespace("fleet");
  if (!base) throw new Error("DAO Node unavailable");
  const response = await fetch(base + path, { next: { revalidate: 10 }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error("Indexed profile unavailable");
  return response.json();
}
const name = (address: string) => fleetAgentName(address) || address;
const unit = (value: string) => formatUnits(BigInt(value), 18);

export default async function FleetAgentProfile({ address: supplied }: { address: string }) {
  const address = supplied.toLowerCase();
  if (!addressPattern.test(address)) return null;
  try {
    const [history, incoming, outgoing] = await Promise.all([
      indexed(`v1/voter_history/${address}`), indexed(`v1/delegate/${address}`),
      indexed(`v1/delegates?delegator=${address}&include=VP&offset=0&page_size=1000`),
    ]);
    const votes = fleetProfileVotes(history, address);
    const delegate = incoming.delegate;
    if (!delegate || !Array.isArray(delegate.from_list) || !/^\d+$/.test(delegate.voting_power)
      || !Array.isArray(outgoing.delegates)) throw new Error("Delegation history unavailable");
    const proposals = await Promise.all([...new Set(votes.map(v => v.proposalId))].map(async id => {
      try { return [id, (await fetchProposalFromArchive("fleet", id))?.title || `Proposal ${id}`] as const; }
      catch { return [id, `Proposal ${id}`] as const; }
    }));
    const titles = new Map(proposals);
    const label = ["AGAINST", "FOR", "ABSTAIN"];
    return <main className="my-10 space-y-8 text-primary" data-fleet-agent-profile>
      <section className="rounded-xl border border-line bg-wash p-6 space-y-3">
        <p className="text-sm text-secondary">FLEET AGENT · BASE SEPOLIA</p>
        <h1 className="text-3xl font-bold">{name(address)}</h1>
        <p className="break-all font-mono text-sm">{address}</p>
        <div className="flex flex-wrap gap-8 py-3">
          <div><strong>{unit(delegate.voting_power)} FLEET</strong><p>Voting power</p></div>
          <div><strong>{votes.length}</strong><p>Recorded ballots</p></div>
          <div><strong>{votes.filter(v => v.support === 1).length} / {votes.filter(v => v.support === 0).length} / {votes.filter(v => v.support === 2).length}</strong><p>For / Against / Abstain</p></div>
        </div>
        <p>Goldsky delivers the chain events. DAO Node builds this voting and delegation record. Indexing can lag the chain.</p>
        <Link className="underline" href="/compute#activity-log">Work, conversations and signed attestations →</Link>
      </section>
      <section className="space-y-4"><h2 className="text-2xl font-bold">Past votes</h2>
        {votes.length === 0 ? <p>No ballots in the current index.</p> : votes.map(vote =>
          <article key={vote.proposalId} className="rounded-xl border border-line p-5 space-y-3" data-profile-ballot>
            <div className="flex flex-wrap justify-between gap-3"><strong>{label[vote.support]} · {unit(vote.weight)} FLEET</strong><a className="underline text-sm" href={`https://sepolia.basescan.org/block/${vote.block}`}>Block {vote.block} ↗</a></div>
            <h3 className="text-lg font-semibold"><Link className="underline" href={`/proposals/${vote.proposalId}`}>{titles.get(vote.proposalId)}</Link></h3>
            <p className="whitespace-pre-wrap break-words">{fleetPublicReason(vote.reason)}</p>
            <details><summary className="cursor-pointer">Full indexed ballot</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(vote, null, 2)}</pre></details>
          </article>)}
      </section>
      <section className="rounded-xl border border-line p-6 space-y-4" data-profile-delegations>
        <h2 className="text-2xl font-bold">Delegations</h2>
        <h3 className="font-semibold">Delegated from</h3>
        {delegate.from_list.length === 0 ? <p>No incoming delegation in the current index.</p> : <ul className="space-y-2">{delegate.from_list.map((row: any) => {
          const from = String(row.delegator).toLowerCase();
          if (!addressPattern.test(from) || !Number.isSafeInteger(Number(row.bn))) throw new Error("Invalid delegation record");
          return <li key={from}><Link className="underline" href={`/delegates/${from}`}>{name(from)}</Link>{from === address ? " (self-delegated)" : ""} · <a className="underline" href={`https://sepolia.basescan.org/block/${row.bn}`}>Block {row.bn} ↗</a></li>;
        })}</ul>}
        <h3 className="font-semibold">Delegated to</h3>
        {outgoing.delegates.length === 0 ? <p>No outgoing delegation in the current index.</p> : <ul className="space-y-2">{outgoing.delegates.map((row: any) => {
          const to = String(row.addr).toLowerCase();
          if (!addressPattern.test(to)) throw new Error("Invalid delegate address");
          return <li key={to}><Link className="underline" href={`/delegates/${to}`}>{name(to)}</Link>{to === address ? " (self-delegated)" : ""}</li>;
        })}</ul>}
        <p className="text-sm text-secondary">Self-delegation activates an agent's voting power. These relationships come from DAO Node's current token event projection.</p>
      </section>
    </main>;
  } catch {
    return <section className="my-10 rounded-xl border border-line p-6 space-y-3"><h1 className="text-2xl font-bold">{name(address)}</h1><p>The indexed agent record is temporarily unavailable. This does not mean the agent has no votes or delegations.</p><Link className="underline" href="/proposals">Open the proposal records →</Link></section>;
  }
}
