import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/**
 * `GET /api/runs/[id]/events`'s Server-Sent Events payload shapes (task 6 controller notes): a new
 * `run.log` line, a pipeline stage change (polled from the run store), or a keep-alive ping.
 */
export type SseEvent =
  | { type: "log"; line: string }
  | { type: "stage"; stage: string; updatedAt: string }
  | { type: "ping" };

/** Formats one event as a Server-Sent Events `data:` frame, UTF-8 text ready to write to the
 *  response stream. */
export function formatSseEvent(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Reads any complete lines appended to `filePath` since byte `offset`. A trailing partial line
 *  (no newline yet) is held back and re-read on the next call, so a line is never split across two
 *  events. A missing file (the run has not written `run.log` yet) reads as no new lines. Injectable
 *  so tests never depend on real polling timing to exercise the log-tailing logic. */
export function defaultReadNewLines(filePath: string, offset: number): { lines: string[]; nextOffset: number } {
  if (!existsSync(filePath)) return { lines: [], nextOffset: offset };
  const size = statSync(filePath).size;
  if (size <= offset) return { lines: [], nextOffset: offset };

  const length = size - offset;
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, "r");
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], nextOffset: offset };

  const complete = text.slice(0, lastNewline);
  const lines = complete.split("\n").filter((line) => line.length > 0);
  return { lines, nextOffset: offset + lastNewline + 1 };
}

export type ReadLinesFn = typeof defaultReadNewLines;

export type PollState = { offset: number; lastStage: string | null };

export type StageLookup = () => Promise<{ stage: string; updatedAt: string } | null>;

/**
 * One poll cycle: reads whatever new `run.log` lines exist since `state.offset`, and emits a
 * `stage` event only when the run store's current stage differs from `state.lastStage`. Pure
 * apart from the injected `readLines`/`getStage`, so it is the unit under test for "append two
 * lines, expect two log events; change stage, expect one stage event."
 */
export async function pollLogAndStage(opts: {
  logPath: string;
  state: PollState;
  getStage: StageLookup;
  readLines?: ReadLinesFn;
}): Promise<{ events: SseEvent[]; state: PollState }> {
  const readLines = opts.readLines ?? defaultReadNewLines;
  const { lines, nextOffset } = readLines(opts.logPath, opts.state.offset);
  const events: SseEvent[] = lines.map((line) => ({ type: "log", line }));

  let lastStage = opts.state.lastStage;
  const record = await opts.getStage();
  if (record && record.stage !== lastStage) {
    events.push({ type: "stage", stage: record.stage, updatedAt: record.updatedAt });
    lastStage = record.stage;
  }

  return { events, state: { offset: nextOffset, lastStage } };
}

export type RunEventsDeps = {
  logPath: string;
  getStage: StageLookup;
  readLines?: ReadLinesFn;
  /** Defaults to 2000ms (controller notes: "poll every 2 s"). */
  pollIntervalMs?: number;
  /** Defaults to 15000ms (controller notes: "{type: 'ping'} every 15 s"). */
  pingIntervalMs?: number;
  signal?: AbortSignal;
};

/**
 * Builds the actual `ReadableStream<Uint8Array>` the events route serves: polls `pollLogAndStage`
 * on `pollIntervalMs`, writes every event it returns as an SSE frame, and separately writes a
 * `{type: "ping"}` frame every `pingIntervalMs` so intermediaries do not time out an idle
 * connection. Stops both timers and closes the stream when `signal` aborts (the client
 * disconnected) or the stream itself is canceled.
 */
export function buildRunEventsStream(deps: RunEventsDeps): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const pingIntervalMs = deps.pingIntervalMs ?? 15000;
  let state: PollState = { offset: 0, lastStage: null };
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    if (pingTimer) clearInterval(pingTimer);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const poll = async (): Promise<void> => {
        try {
          const result = await pollLogAndStage({
            logPath: deps.logPath,
            state,
            getStage: deps.getStage,
            ...(deps.readLines ? { readLines: deps.readLines } : {}),
          });
          state = result.state;
          for (const event of result.events) controller.enqueue(encoder.encode(formatSseEvent(event)));
        } catch {
          // A transient read (log rotated mid-write) or store error should not kill the stream;
          // the next poll tries again rather than tearing down a live view over one bad tick.
        }
      };
      void poll();
      pollTimer = setInterval(() => void poll(), pollIntervalMs);
      pingTimer = setInterval(() => controller.enqueue(encoder.encode(formatSseEvent({ type: "ping" }))), pingIntervalMs);
      deps.signal?.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      stop();
    },
  });
}
