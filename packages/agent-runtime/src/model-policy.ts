import { ModelVoteV1 } from "@fleet/schemas";
import { renderVoteReason } from "@fleet/sdk";
import type { VoteV1 } from "@fleet/schemas";
import type { AnchoredProposal, DecisionPolicy, PolicyMeta, PolicyOutput } from "./policy.js";
import { buildEvaluateProposalPrompt } from "./providers/prompts.js";
import { DEFAULT_VOTE_OR_STEP_MAX_TOKENS } from "./providers/openrouter.js";
import { withOneRepair } from "./providers/types.js";
import type { CompleteResult, Provider, Usage } from "./providers/types.js";

/** Spec 10.6: 60 seconds per inference, the same budget the task loop uses. */
export const MODEL_POLICY_TIMEOUT_MS = 60_000;

export type ModelPolicyOpts = {
  provider: Provider;
  /** Recorded on the job, never sent to the model: which revision of the prompt files this vote
   *  was produced under (`ExperimentConfigV1.fleet.members[].promptVersion`). */
  promptVersion: string;
  maxTokens?: number;
  timeoutMs?: number;
};

function assembleVote(model: ModelVoteV1, proposalId: string): VoteV1 {
  const { confidenceBps, ...fields } = model;
  return { schema: "fleet.vote.v1", proposalId, ...fields,
    ...(confidenceBps === null || confidenceBps === undefined ? {} : { confidenceBps }) };
}

// Validate the exact signed text before accepting a model response. An oversized
// explanation gets the same one model-authored repair as other malformed output.
const SignableModelVote = ModelVoteV1.superRefine((model, context) => {
  try { renderVoteReason(assembleVote(model, "0")); }
  catch {
    context.addIssue({ code: "custom", message: "The combined onchain rationale, risk flags and confidence must fit 1024 UTF-8 bytes. Shorten the explanation and flags while preserving your decision and its meaning." });
  }
});

function metaFrom(
  provider: Provider,
  promptVersion: string,
  latencyMs: number,
  usage: Usage | undefined,
): PolicyMeta {
  return {
    provider: provider.name,
    model: usage?.model ?? "unknown",
    promptVersion,
    latencyMs,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
  };
}

/**
 * The model-backed `DecisionPolicy` (spec 10.5): builds the `evaluate-proposal` prompt from the
 * anchored state the `Worker` already read, asks the provider for a `ModelVoteV1` through
 * `withOneRepair`, and assembles the `VoteV1` deterministically around it.
 *
 * What the model chooses: `support`, `rationale`, `assumptions`, `riskFlags`, and optionally
 * `confidenceBps`. What this code chooses, always: `schema`, and `proposalId`, taken from
 * `input.proposal.proposalId` so a ballot can only ever be about the proposal the worker anchored
 * its read to. There is no path here where a model's own idea of the proposal id, or of what a
 * vote's schema is, reaches a ballot.
 *
 * The three failure mappings follow spec 10.6 exactly. A reply that will not parse as
 * `ModelVoteV1` is `malformed`, which the `Worker` turns into `worker_failed` and a missing vote:
 * never a For, never a synthesized Abstain. A timeout or a transport failure is `absent`, also a
 * missing vote, distinguished from `malformed` because nothing about the model's judgment was
 * observed at all. Every branch carries `meta`, so the job record shows what the attempt cost even
 * when it produced no ballot.
 */
export class ModelPolicy implements DecisionPolicy {
  private readonly provider: Provider;
  private readonly promptVersion: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(opts: ModelPolicyOpts) {
    this.provider = opts.provider;
    this.promptVersion = opts.promptVersion;
    this.maxTokens = opts.maxTokens ?? DEFAULT_VOTE_OR_STEP_MAX_TOKENS;
    this.timeoutMs = opts.timeoutMs ?? MODEL_POLICY_TIMEOUT_MS;
  }

  async evaluateProposal(input: AnchoredProposal): Promise<PolicyOutput> {
    const prompt = buildEvaluateProposalPrompt(input);
    const result = (await withOneRepair(this.provider, {
      system: prompt.system,
      user: prompt.user,
      schema: SignableModelVote,
      maxTokens: this.maxTokens,
      timeoutMs: this.timeoutMs,
    })) as CompleteResult<ModelVoteV1>;

    const meta = metaFrom(this.provider, this.promptVersion, result.latencyMs, result.usage);

    if (!result.ok) {
      if (result.error === "malformed") {
        return { kind: "malformed", raw: result.raw, meta };
      }
      // `timeout` and `provider`: the model never expressed a judgment, so there is nothing to
      // report as malformed output either. Spec 10.6's missing vote.
      return { kind: "absent", why: `${result.error}: ${result.raw}`, meta };
    }

    const vote = assembleVote(result.value, input.proposal.proposalId.toString());

    return { kind: "vote", vote, meta };
  }
}
