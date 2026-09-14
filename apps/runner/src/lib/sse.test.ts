import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunEventsStream, defaultReadNewLines, formatSseEvent, pollLogAndStage } from "./sse.js";
import type { SseEvent } from "./sse.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-sse-"));
  logPath = path.join(dir, "run.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("formatSseEvent", () => {
  it("renders a data: frame terminated by a blank line", () => {
    expect(formatSseEvent({ type: "ping" })).toBe('data: {"type":"ping"}\n\n');
  });
});

describe("defaultReadNewLines", () => {
  it("reads no lines when the file does not exist yet", () => {
    const result = defaultReadNewLines(logPath, 0);
    expect(result).toEqual({ lines: [], nextOffset: 0 });
  });

  it("holds back a trailing partial line until it is newline-terminated", () => {
    const fd = openSync(logPath, "a");
    appendFileSync(fd, "first line\npartial");
    closeSync(fd);

    const first = defaultReadNewLines(logPath, 0);
    expect(first.lines).toEqual(["first line"]);

    appendFileSync(logPath, " line completes\n");
    const second = defaultReadNewLines(logPath, first.nextOffset);
    expect(second.lines).toEqual(["partial line completes"]);
  });
});

describe("pollLogAndStage", () => {
  it("emits one log event per new line and no stage event when the stage has not changed", async () => {
    appendFileSync(logPath, "line one\nline two\n");
    const getStage = async () => ({ stage: "AGENTS_RUNNING", updatedAt: "2026-09-14T00:00:00.000Z" });

    const first = await pollLogAndStage({ logPath, state: { offset: 0, lastStage: null }, getStage });
    expect(first.events).toEqual<SseEvent[]>([
      { type: "log", line: "line one" },
      { type: "log", line: "line two" },
      { type: "stage", stage: "AGENTS_RUNNING", updatedAt: "2026-09-14T00:00:00.000Z" },
    ]);

    const second = await pollLogAndStage({ logPath, state: first.state, getStage });
    expect(second.events).toEqual([]);
  });

  it("emits a stage event only when the stage actually changes, and picks up new lines separately", async () => {
    let stage = { stage: "TASK_OPENED", updatedAt: "t0" };
    const getStage = async () => stage;

    appendFileSync(logPath, "opened\n");
    const first = await pollLogAndStage({ logPath, state: { offset: 0, lastStage: null }, getStage });
    expect(first.events).toEqual([
      { type: "log", line: "opened" },
      { type: "stage", stage: "TASK_OPENED", updatedAt: "t0" },
    ]);

    appendFileSync(logPath, "still running\n");
    const second = await pollLogAndStage({ logPath, state: first.state, getStage });
    expect(second.events).toEqual([{ type: "log", line: "still running" }]);

    stage = { stage: "AGENTS_RUNNING", updatedAt: "t1" };
    const third = await pollLogAndStage({ logPath, state: second.state, getStage });
    expect(third.events).toEqual([{ type: "stage", stage: "AGENTS_RUNNING", updatedAt: "t1" }]);
  });

  it("emits nothing when the run store has no stage yet", async () => {
    appendFileSync(logPath, "waiting\n");
    const result = await pollLogAndStage({ logPath, state: { offset: 0, lastStage: null }, getStage: async () => null });
    expect(result.events).toEqual([{ type: "log", line: "waiting" }]);
  });
});

describe("buildRunEventsStream", () => {
  it("streams log and stage SSE frames as the file and stage change, and stops on abort", async () => {
    appendFileSync(logPath, "boot\n");
    let stage: { stage: string; updatedAt: string } | null = null;
    const controller = new AbortController();

    const stream = buildRunEventsStream({
      logPath,
      getStage: async () => stage,
      pollIntervalMs: 10,
      pingIntervalMs: 100000,
      signal: controller.signal,
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    async function readUntil(predicate: (text: string) => boolean, timeoutMs = 2000): Promise<string> {
      let collected = "";
      const deadline = Date.now() + timeoutMs;
      while (!predicate(collected)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for output; collected so far: ${collected}`);
        const { value, done } = await reader.read();
        if (done) break;
        collected += decoder.decode(value);
      }
      return collected;
    }

    const bootText = await readUntil((t) => t.includes('"line":"boot"'));
    expect(bootText).toContain('data: {"type":"log","line":"boot"}');

    stage = { stage: "DEPLOYED", updatedAt: "t0" };
    const stageText = await readUntil((t) => t.includes('"type":"stage"'));
    expect(stageText).toContain('"stage":"DEPLOYED"');

    controller.abort();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});
