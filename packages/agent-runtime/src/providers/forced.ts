import type { CompleteRequest, CompleteResult, Provider } from "./types.js";

/** The exact `raw` a forced-malformed call reports, so a job record's `lastError` names the knob
 *  that produced it rather than looking like a real model failure. */
export const FORCED_MALFORMED_RAW = "forced-malformed";

/**
 * Wraps a provider so every `complete` call fails as `"malformed"` without the inner provider
 * ever being asked. This is a deliberate test knob, not a failure mode the system produces on its
 * own: the Runner applies it to the vote provider of the agents named in
 * `FLEET_FORCE_MALFORMED_AGENTS` so an acceptance run can demonstrate spec 10.6's rule live,
 * namely that invalid model output becomes a missing vote and a `worker_failed` job, never a For
 * and never a synthesized Abstain.
 *
 * `withOneRepair`'s single retry is deliberately not special-cased: it re-asks this wrapper and
 * gets the same failure, which is the point, since a knob that a repair round could undo would
 * not prove anything. `truncated` is never set, so the retry does not raise the token budget for
 * a call that was never going to reach a model.
 *
 * `name` is the inner provider's, so the job record still records which adapter the agent was
 * configured with. `agentId` is carried only so a caller can log which agent is being forced; the
 * result itself is the same for every agent.
 */
export function forceMalformedProvider(inner: Provider, agentId: number): Provider & { forcedAgentId: number } {
  return {
    name: inner.name,
    forcedAgentId: agentId,
    async complete<T>(_req: CompleteRequest<T>): Promise<CompleteResult<T>> {
      return { ok: false, error: "malformed", raw: FORCED_MALFORMED_RAW, latencyMs: 0 };
    },
  };
}
