export type FleetProfileVote = {
  proposalId: string; voter: string; support: number; weight: string;
  reason: string; block: number;
};

/** DAO Node's compact voter history is the indexed source, not the empty legacy SQL views. */
export function fleetProfileVotes(input: unknown, address: string): FleetProfileVote[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as any).voter_history)) throw new Error("Voting history unavailable");
  return (input as any).voter_history.map((row: any) => {
    if (!/^\d+$/.test(String(row.proposal_id)) || row.voter?.toLowerCase() !== address.toLowerCase()
      || ![0, 1, 2].includes(Number(row.support)) || !/^\d+$/.test(String(row.weight))
      || !Number.isSafeInteger(Number(row.bn)) || Number(row.bn) < 0
      || (row.reason !== undefined && typeof row.reason !== "string")) throw new Error("Invalid indexed vote");
    return { proposalId: String(row.proposal_id), voter: row.voter.toLowerCase(), support: Number(row.support),
      weight: String(row.weight), reason: row.reason || "No reason recorded.", block: Number(row.bn) };
  }).sort((a: FleetProfileVote, b: FleetProfileVote) => b.block - a.block);
}

export function fleetPublicReason(reason: string): string {
  try { const parsed = JSON.parse(reason); return typeof parsed.rationale === "string" ? parsed.rationale : reason; }
  catch { return reason; }
}
