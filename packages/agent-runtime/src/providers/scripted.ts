import type { CompleteRequest, CompleteResult, Provider, Usage } from "./types.js";

/** What one scripted call answers with: `raw` is the exact text a real provider would have
 *  returned (before JSON parsing and schema validation, both of which `ScriptedProvider.complete`
 *  still performs, the same as `OpenRouterProvider` and `ClaudeCliProvider`), plus an optional
 *  `usage` and `truncated` flag for exercising `withOneRepair`'s truncation path without a
 *  network call. */
export type ScriptedReply = { raw: string; usage?: Usage; truncated?: boolean };

export type ScriptedResponder = (req: {
  system: string;
  user: string;
  maxTokens: number;
}) => ScriptedReply | Promise<ScriptedReply>;

/**
 * A `Provider` implementation with no model behind it: `respond` is supplied by the caller (a
 * fixed queue, a function of the request, whatever a test or a scripted experiment needs) and
 * its `raw` output is parsed and validated exactly like a real adapter's would be, so this is a
 * faithful stand-in for `withOneRepair` and any future `ModelPolicy` wiring, not a shortcut that
 * skips validation. It never throws: a `respond` that rejects is reported as a `"provider"`
 * failure, matching how a real transport failure is reported.
 */
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  private readonly respond: ScriptedResponder;
  private readonly defaultModel: string;

  constructor(respond: ScriptedResponder, opts?: { model?: string }) {
    this.respond = respond;
    this.defaultModel = opts?.model ?? "scripted";
  }

  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    const started = Date.now();
    let reply: ScriptedReply;
    try {
      reply = await this.respond({ system: req.system, user: req.user, maxTokens: req.maxTokens });
    } catch (err) {
      return {
        ok: false,
        error: "provider",
        raw: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
      };
    }
    const latencyMs = Date.now() - started;
    const usage: Usage = reply.usage ?? { inputTokens: 0, outputTokens: 0, model: this.defaultModel };

    if (reply.truncated) {
      return { ok: false, error: "malformed", raw: reply.raw, usage, latencyMs, truncated: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.raw);
    } catch {
      return { ok: false, error: "malformed", raw: reply.raw, usage, latencyMs };
    }

    const result = req.schema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: "malformed", raw: reply.raw, usage, latencyMs };
    }

    return { ok: true, value: result.data, usage, latencyMs, raw: reply.raw };
  }
}
