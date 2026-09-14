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
  usage?: { input_tokens?: number; output_tokens?: number };
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
 * `Provider` backed by the local Claude Code CLI: spawns `claude -p --output-format json --model
 * <m>` with the prompt on stdin, parses the JSON envelope's `result`, then the fenced or bare
 * JSON inside that. This is the default local provider (controller notes / progress ledger: no
 * OpenRouter key was available when Part 4 began, and Claude Code is installed on this machine),
 * with no per-call cost and no network dependency.
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
    const started = Date.now();
    const args = ["-p", "--output-format", "json", "--model", this.model];

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
        child.stdin.write(`${req.system}\n\n${req.user}`);
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

    if (envelope.is_error) {
      return { ok: false, error: "provider", raw: stdout, latencyMs };
    }

    if (typeof envelope.result !== "string") {
      return { ok: false, error: "malformed", raw: stdout, latencyMs };
    }
    const result = envelope.result;
    const usage = this.usageFromEnvelope(envelope);
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
    const inputTokens = envelope.usage?.input_tokens;
    const outputTokens = envelope.usage?.output_tokens;
    if (typeof inputTokens === "number" && typeof outputTokens === "number") {
      return { inputTokens, outputTokens, model: this.model };
    }
    return { inputTokens: 0, outputTokens: 0, model: "unknown" };
  }
}
