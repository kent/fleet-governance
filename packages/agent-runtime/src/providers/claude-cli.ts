import { spawn } from "node:child_process";
import type { CompleteRequest, CompleteResult, Provider, Usage } from "./types.js";

/** The minimal shape this provider needs from a spawned child process: two readable streams, a
 *  writable stdin, `close`/`error` events, and `kill()`. Node's real `ChildProcessWithoutNullStreams`
 *  (what `node:child_process`'s `spawn` returns with the default pipe stdio) satisfies this
 *  structurally; tests inject a much smaller fake that does the same, without needing a real
 *  binary (brief: "with a canned envelope and a fake binary"). */
export type ClaudeCliChildProcess = {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stdin: { write(data: string): unknown; end(): unknown };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(): unknown;
};

export type SpawnFn = (bin: string, args: string[]) => ClaudeCliChildProcess;

export type ClaudeCliProviderOpts = {
  model?: string;
  /** Defaults to `"claude"` (the Claude Code CLI on `$PATH`). */
  bin?: string;
  spawnImpl?: SpawnFn;
};

/** The subset of the CLI's `--output-format json` envelope this adapter reads. Real envelopes
 *  carry more fields (`session_id`, `total_cost_usd`, `duration_ms`, ...); everything else is
 *  ignored. */
type ClaudeCliEnvelope = {
  type?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/** The envelope's `result` is markdown-ish text that may wrap its JSON in a fenced code block;
 *  when it does not, the controller notes call for parsing the result text itself as "bare"
 *  JSON. Extracts the fenced block's contents when present, otherwise the trimmed whole string. */
function extractJsonText(result: string): string {
  const fenced = FENCED_JSON_PATTERN.exec(result);
  if (fenced?.[1] !== undefined) {
    return fenced[1].trim();
  }
  return result.trim();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Inference-only Claude Code CLI adapter. Built-in tools, MCP servers, skills, hooks and other
 * customizations are disabled: model output must return through the fleet's tool gateway.
 * Unsupported flags fail the provider call rather than retrying with weaker restrictions.
 * Authentication and inference still use the operator's Claude account and network.
 *
 * Usage counters come from the envelope's `usage` object when the CLI reports one; when it does
 * not, they are recorded as unknown (`{ inputTokens: 0, outputTokens: 0, model: "unknown" }`)
 * rather than guessed, per the brief.
 */
export class ClaudeCliProvider implements Provider {
  readonly name = "claude-cli";
  private readonly model: string;
  private readonly bin: string;
  private readonly spawnImpl: SpawnFn;

  constructor(opts?: ClaudeCliProviderOpts) {
    this.model = opts?.model ?? "claude-sonnet-5";
    this.bin = opts?.bin ?? "claude";
    this.spawnImpl = opts?.spawnImpl ?? ((bin, args) => spawn(bin, args));
  }

  async complete<T>(req: CompleteRequest<T>): Promise<CompleteResult<T>> {
    if (req.spending) return { ok: false, error: "provider", raw: "inference_budget_unsupported_provider", latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, model: this.model, costUsd: 0 } };
    const started = Date.now();
    const args = [
      "-p", "--output-format", "json", "--model", this.model,
      "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--no-session-persistence", "--system-prompt", req.system,
    ];

    return new Promise<CompleteResult<T>>((resolve) => {
      let settled = false;
      const settle = (result: CompleteResult<T>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ClaudeCliChildProcess;
      try {
        child = this.spawnImpl(this.bin, args);
      } catch (err) {
        settle({ ok: false, error: "provider", raw: errorMessage(err), latencyMs: Date.now() - started });
        return;
      }

      let stdout = "";
      let stderr = "";

      const timer = setTimeout(() => {
        child.kill();
        settle({ ok: false, error: "timeout", raw: stdout, latencyMs: Date.now() - started });
      }, req.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        settle({ ok: false, error: "provider", raw: errorMessage(err), latencyMs: Date.now() - started });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        settle(this.parseResult(req, code, stdout, stderr, Date.now() - started));
      });

      try {
        child.stdin.write(req.user);
        child.stdin.end();
      } catch {
        // A child that already exited (a fake binary in a test, or a real CLI that failed to
        // start) may have a closed stdin; the `close`/`error` handlers above still resolve this
        // call regardless.
      }
    });
  }

  private parseResult<T>(
    req: CompleteRequest<T>,
    code: number | null,
    stdout: string,
    stderr: string,
    latencyMs: number,
  ): CompleteResult<T> {
    if (code !== 0) {
      return { ok: false, error: "provider", raw: stderr || stdout, latencyMs };
    }

    let envelope: ClaudeCliEnvelope;
    try {
      envelope = JSON.parse(stdout) as ClaudeCliEnvelope;
    } catch {
      return { ok: false, error: "malformed", raw: stdout, latencyMs };
    }

    const usage = this.usageFromEnvelope(envelope);
    if (envelope.is_error) {
      return { ok: false, error: "provider", raw: stdout, latencyMs, usage };
    }

    if (typeof envelope.result !== "string") {
      return { ok: false, error: "malformed", raw: stdout, latencyMs, usage };
    }
    const result = envelope.result;
    const jsonText = extractJsonText(result);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return { ok: false, error: "malformed", raw: result, usage, latencyMs };
    }

    const validated = req.schema.safeParse(parsed);
    if (!validated.success) {
      return { ok: false, error: "malformed", raw: result, usage, latencyMs };
    }

    return { ok: true, value: validated.data, usage, latencyMs, raw: result };
  }

  private usageFromEnvelope(envelope: ClaudeCliEnvelope): Usage {
    const inputTokens = envelope.usage?.input_tokens === undefined ? undefined : envelope.usage.input_tokens + (envelope.usage.cache_read_input_tokens ?? 0) + (envelope.usage.cache_creation_input_tokens ?? 0);
    const outputTokens = envelope.usage?.output_tokens;
    if (typeof inputTokens === "number" && typeof outputTokens === "number") {
      return { inputTokens, outputTokens, model: this.model, ...(typeof envelope.total_cost_usd === "number" && Number.isFinite(envelope.total_cost_usd) && envelope.total_cost_usd >= 0 ? { costUsd: envelope.total_cost_usd } : {}) };
    }
    return { inputTokens: 0, outputTokens: 0, model: "unknown" };
  }
}
