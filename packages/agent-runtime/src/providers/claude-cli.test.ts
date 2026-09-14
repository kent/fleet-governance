import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClaudeCliProvider } from "./claude-cli.js";
import type { ClaudeCliChildProcess, SpawnFn } from "./claude-cli.js";
import type { CompleteRequest } from "./types.js";

const Schema = z.object({ schema: z.literal("fleet.vote.v1"), support: z.enum(["FOR", "AGAINST", "ABSTAIN"]) }).strict();
type Schema = z.infer<typeof Schema>;

function req(overrides: Partial<CompleteRequest<Schema>> = {}): CompleteRequest<Schema> {
  return { system: "sys", user: "usr", schema: Schema, maxTokens: 100, timeoutMs: 60_000, ...overrides };
}

/** A fake child process: real Readable/Writable streams for stdout/stderr/stdin, plus an
 *  EventEmitter for `close`/`error`, all wired so a test can push output and finish the process
 *  on its own schedule (or never, for the timeout test). No real binary runs. */
class FakeChildProcess extends EventEmitter implements ClaudeCliChildProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { write: vi.fn(), end: vi.fn() };
  killed = false;

  kill(): void {
    this.killed = true;
  }

  finish(code: number | null, stdout: string, stderr = ""): void {
    if (stdout) this.stdout.write(stdout);
    if (stderr) this.stderr.write(stderr);
    // Let the PassThrough streams flush their "data" events before "close" fires, the same order
    // a real child process's stdio produces.
    setImmediate(() => this.emit("close", code));
  }
}

let activeChild: FakeChildProcess | null = null;
afterEach(() => {
  activeChild = null;
  vi.useRealTimers();
});

function spawnImplFor(child: FakeChildProcess): SpawnFn {
  activeChild = child;
  return () => child;
}

describe("ClaudeCliProvider", () => {
  it("parses a canned envelope with a fenced JSON result and reports envelope usage", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const envelope = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: 'Here is my vote:\n```json\n{"schema":"fleet.vote.v1","support":"AGAINST"}\n```',
      usage: { input_tokens: 120, output_tokens: 45 },
    };

    const promise = provider.complete(req());
    child.finish(0, JSON.stringify(envelope));
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ schema: "fleet.vote.v1", support: "AGAINST" });
      expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 45, model: "claude-sonnet-5" });
    }
  });

  it("parses a canned envelope whose result is bare JSON (no fence)", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const envelope = {
      type: "result",
      is_error: false,
      result: '{"schema":"fleet.vote.v1","support":"FOR"}',
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const promise = provider.complete(req());
    child.finish(0, JSON.stringify(envelope));
    const result = await promise;

    expect(result.ok).toBe(true);
  });

  it("records usage as unknown when the envelope carries none", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const envelope = { type: "result", is_error: false, result: '{"schema":"fleet.vote.v1","support":"FOR"}' };

    const promise = provider.complete(req());
    child.finish(0, JSON.stringify(envelope));
    const result = await promise;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, model: "unknown" });
  });

  it("reports malformed when stdout is not JSON at all", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const promise = provider.complete(req());
    child.finish(0, "the CLI crashed and printed a stack trace, not JSON");
    const result = await promise;

    expect(result).toMatchObject({ ok: false, error: "malformed" });
  });

  it("reports malformed when the envelope's result is not valid JSON or fenced JSON", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const envelope = { type: "result", is_error: false, result: "I could not decide, sorry." };

    const promise = provider.complete(req());
    child.finish(0, JSON.stringify(envelope));
    const result = await promise;

    expect(result).toMatchObject({ ok: false, error: "malformed" });
  });

  it("reports malformed when the parsed result fails the schema", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const envelope = { type: "result", is_error: false, result: '{"schema":"fleet.vote.v1","support":"MAYBE"}' };

    const promise = provider.complete(req());
    child.finish(0, JSON.stringify(envelope));
    const result = await promise;

    expect(result).toMatchObject({ ok: false, error: "malformed" });
  });

  it("reports a provider error when the CLI exits non-zero", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const promise = provider.complete(req());
    child.finish(1, "", "claude: authentication error");
    const result = await promise;

    expect(result).toMatchObject({ ok: false, error: "provider", raw: "claude: authentication error" });
  });

  it("reports a provider error when the envelope itself flags is_error", async () => {
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const envelope = { type: "result", subtype: "error_max_turns", is_error: true, result: "" };

    const promise = provider.complete(req());
    child.finish(0, JSON.stringify(envelope));
    const result = await promise;

    expect(result).toMatchObject({ ok: false, error: "provider" });
  });

  it("reports a provider error and never throws when spawning the binary itself fails", async () => {
    const provider = new ClaudeCliProvider({
      spawnImpl: () => {
        throw new Error("spawn claude ENOENT");
      },
    });

    const result = await provider.complete(req());

    expect(result).toMatchObject({ ok: false, error: "provider", raw: "spawn claude ENOENT" });
  });

  it("times out at the configured limit (fake timer) and kills the child, never returning a vote", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const promise = provider.complete(req({ timeoutMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await promise;

    expect(result).toMatchObject({ ok: false, error: "timeout" });
    expect(child.killed).toBe(true);
  });

  it("does not time out just before the limit, and a late close after a timeout does not override it", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({ spawnImpl: spawnImplFor(child) });

    const promise = provider.complete(req({ timeoutMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(child.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    // A close arriving after the timeout already fired must not resolve the promise a second
    // time with a different (ok) result.
    child.finish(0, JSON.stringify({ type: "result", is_error: false, result: '{"schema":"fleet.vote.v1","support":"FOR"}' }));
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toMatchObject({ ok: false, error: "timeout" });
  });

  it("passes --model and spawns claude -p --output-format json with the prompt on stdin", async () => {
    let seenBin = "";
    let seenArgs: string[] = [];
    const child = new FakeChildProcess();
    const provider = new ClaudeCliProvider({
      model: "claude-opus-5",
      spawnImpl: (bin, args) => {
        seenBin = bin;
        seenArgs = args;
        return child;
      },
    });

    const promise = provider.complete(req());
    child.finish(0, JSON.stringify({ type: "result", is_error: false, result: '{"schema":"fleet.vote.v1","support":"FOR"}' }));
    await promise;

    expect(seenBin).toBe("claude");
    expect(seenArgs).toEqual(["-p", "--output-format", "json", "--model", "claude-opus-5"]);
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining("sys"));
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining("usr"));
    expect(child.stdin.end).toHaveBeenCalled();
  });
});
