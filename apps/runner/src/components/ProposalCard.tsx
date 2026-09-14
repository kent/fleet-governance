import { parseDecisionDescription, parseVoteReason } from "@fleet/sdk";

/**
 * `ProposalCard`: kind, decoded action, For/Against/Abstain tallies, status, and each vote (task 6
 * controller notes). Keeps the two presentation registers apart (spec 11.4, Decision trace): the
 * card's own fields (kind, status, tally, the raw description and reason text) are the onchain
 * facts; `parseDecisionDescription`'s decoded summary/rationale and `parseVoteReason`'s parsed
 * fields are agent-authored text or "parsed from the reason", each under its own labeled section,
 * never inside an onchain label.
 */

export type ProposalCardVote = { voter: string; agentId: number | null; support: 0 | 1 | 2 | null; reason: string | null };
export type ProposalCardTally = {
  forTokens: string;
  againstTokens: string;
  abstainTokens: string;
  forMembers: number;
  againstMembers: number;
  abstainMembers: number;
};
export type ProposalCardProps = {
  proposalId: string;
  taskId: string;
  kind: string | null;
  status: string;
  rawDescription: string;
  tally: ProposalCardTally;
  votes: readonly ProposalCardVote[];
  agoraLink: string | null;
};

const SUPPORT_LABEL: Record<0 | 1 | 2, string> = { 0: "AGAINST", 1: "FOR", 2: "ABSTAIN" };

export default function ProposalCard(props: ProposalCardProps) {
  let decoded: ReturnType<typeof parseDecisionDescription> | null = null;
  let decodeError: string | null = null;
  try {
    decoded = parseDecisionDescription(props.rawDescription);
  } catch (err) {
    decodeError = err instanceof Error ? err.message : String(err);
  }

  return (
    <article data-proposal-id={props.proposalId} data-status={props.status}>
      <h3>
        Proposal {props.proposalId} <small>task {props.taskId}</small>
      </h3>

      <section aria-label="Onchain">
        <p>
          <strong>Onchain kind:</strong> {props.kind ?? "kind not yet indexed"}
        </p>
        <p>
          <strong>Onchain status:</strong> {props.status}
        </p>
        <p>
          <strong>Onchain tally:</strong> For {props.tally.forTokens} ({props.tally.forMembers} members) · Against{" "}
          {props.tally.againstTokens} ({props.tally.againstMembers} members) · Abstain {props.tally.abstainTokens} (
          {props.tally.abstainMembers} members)
        </p>
        {props.agoraLink && (
          <p>
            <a href={props.agoraLink} target="_blank" rel="noreferrer">
              View on Agora Next
            </a>
          </p>
        )}
      </section>

      <section aria-label="Agent-authored text">
        <h4>Agent-authored text</h4>
        {decoded ? (
          <div>
            <p>
              <strong>Summary:</strong> {decoded.decision.summary}
            </p>
            <p>
              <strong>Rationale:</strong> {decoded.decision.rationale}
            </p>
            {decoded.decision.assumptions.length > 0 && (
              <p>
                <strong>Assumptions:</strong> {decoded.decision.assumptions.join("; ")}
              </p>
            )}
            {decoded.decision.riskFlags.length > 0 && (
              <p>
                <strong>Risk flags:</strong> {decoded.decision.riskFlags.join("; ")}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p>description did not decode{decodeError ? `: ${decodeError}` : ""}</p>
            <pre>{props.rawDescription}</pre>
          </div>
        )}
      </section>

      <section aria-label="Votes">
        <h4>Votes</h4>
        <ul>
          {props.votes.map((vote) => {
            const parsed = vote.reason ? parseVoteReason(vote.reason) : null;
            return (
              <li key={vote.voter}>
                <span>
                  Agent {vote.agentId ?? "unknown"} ({vote.voter})
                </span>{" "}
                <span>Onchain support: {vote.support !== null ? SUPPORT_LABEL[vote.support] : "no vote cast"}</span>{" "}
                {vote.reason && <span>Onchain reason: &quot;{vote.reason}&quot;</span>}
                {parsed && (
                  <span>
                    {" "}
                    (parsed from the reason: support {parsed.support ?? "n/a"}, flags{" "}
                    {parsed.flags.length > 0 ? parsed.flags.join(", ") : "none"}, confidence {parsed.confidence ?? "n/a"})
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </article>
  );
}
