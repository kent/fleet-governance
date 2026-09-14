import type { VoteV1 } from "@fleet/schemas";
import type { AnchoredProposal, DecisionPolicy, PolicyOutput } from "./policy.js";

/** One scripted directive for one agent, spec 10.6's test vocabulary: a vote to cast, a
 *  deliberate no-vote, a deliberately broken policy output, or a slow one. */
export type ScriptedDirective = "FOR" | "AGAINST" | "ABSTAIN" | "ABSENT" | "MALFORMED" | "LATE";

function isCastable(d: ScriptedDirective): d is "FOR" | "AGAINST" | "ABSTAIN" {
  return d === "FOR" || d === "AGAINST" || d === "ABSTAIN";
}

/**
 * A deterministic, non-model `DecisionPolicy` driven entirely by a fixed script keyed by agent
 * id, the only policy this part ships (spec 10.5's model-backed reasoning arrives in Part 4).
 * Given the same script and the same `AnchoredProposal`, always produces the same `PolicyOutput`:
 * nothing here reads wall-clock content, randomness, or any field of `input` besides
 * `input.member.agentId` and (for the rendered rationale) `input.member.role` and
 * `input.proposal.proposalId`.
 *
 * `"LATE"` waits `opts.lateDelayMs` (default 0) before resolving with a `FOR` vote, modeling a
 * slow model so a caller can exercise the worker's submission-margin check (spec 10.6): the delay
 * itself never decides the outcome, it only makes the caller wait, exactly like a real inference
 * call would.
 */
export class ScriptedPolicy implements DecisionPolicy {
  private readonly script: Record<number, ScriptedDirective>;
  private readonly lateDelayMs: number;

  constructor(script: Record<number, ScriptedDirective>, opts?: { lateDelayMs?: number }) {
    this.script = script;
    this.lateDelayMs = opts?.lateDelayMs ?? 0;
  }

  async evaluateProposal(input: AnchoredProposal): Promise<PolicyOutput> {
    const agentId = input.member.agentId;
    const directive = this.script[agentId];

    if (directive === undefined) {
      return { kind: "absent", why: `no script entry for agent ${agentId}` };
    }

    if (directive === "ABSENT") {
      return { kind: "absent", why: `scripted absent for agent ${agentId}` };
    }

    if (directive === "MALFORMED") {
      return { kind: "malformed", raw: `scripted malformed output for agent ${agentId}` };
    }

    if (directive === "LATE") {
      if (this.lateDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.lateDelayMs));
      }
      return { kind: "vote", vote: this.buildVote(input, "FOR") };
    }

    if (isCastable(directive)) {
      return { kind: "vote", vote: this.buildVote(input, directive) };
    }

    // Exhaustive by ScriptedDirective's type; unreachable in practice.
    return { kind: "malformed", raw: `unrecognized scripted directive for agent ${agentId}` };
  }

  private buildVote(input: AnchoredProposal, support: "FOR" | "AGAINST" | "ABSTAIN"): VoteV1 {
    return {
      schema: "fleet.vote.v1",
      proposalId: input.proposal.proposalId.toString(),
      support,
      rationale: `Scripted ${support} from agent ${input.member.agentId} (${input.member.role})`,
      assumptions: [],
      riskFlags: [],
    };
  }
}
