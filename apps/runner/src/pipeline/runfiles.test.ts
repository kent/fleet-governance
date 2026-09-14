import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayLogLine, InterventionLine, ObjectionLine, RUN_FILES, StepLine, appendJsonl, readJsonl } from "./runfiles.js";

describe("runfiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "runfiles-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends and reads step lines, creating the directory and serializing bigints", () => {
    const file = path.join(dir, "nested", RUN_FILES.steps);
    appendJsonl(file, { type: "step", at: "2026-09-14T00:00:00.000Z", agentId: 0, seq: 1, tool: { class: "read_repo", target: "src/index.js", args: { n: 5n } }, why: "look", source: "model" });
    appendJsonl(file, { type: "step", at: "2026-09-14T00:00:01.000Z", agentId: 0, seq: 2, tool: { class: "run_tests", target: ".", args: {} }, why: "check", source: "adopted_path" });
    const lines = readJsonl(file, StepLine);
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);
    expect((lines[0]?.tool.args as { n: string }).n).toBe("5");
  });

  it("returns an empty list for a missing file", () => {
    expect(readJsonl(path.join(dir, RUN_FILES.gateway), GatewayLogLine)).toEqual([]);
  });

  it("rejects a line that does not match the shape, naming the line", () => {
    const file = path.join(dir, RUN_FILES.objections);
    appendJsonl(file, { type: "objection", at: "t", agentId: 1, seq: 3, objects: false, alternative: null, why: "fine", proposalId: null });
    writeFileSync(file, `${JSON.stringify({ type: "objection", agentId: "one" })}\n`, { flag: "a" });
    expect(() => readJsonl(file, ObjectionLine)).toThrow(/:2: does not match/);
  });

  it("rejects invalid JSON, naming the line", () => {
    const file = path.join(dir, RUN_FILES.interventions);
    writeFileSync(file, "{not json\n");
    expect(() => readJsonl(file, InterventionLine)).toThrow(/:1: not valid JSON/);
  });

  it("accepts a well-formed gateway record and a guardian intervention", () => {
    const gw = GatewayLogLine.parse({
      ts: "2026-09-14T00:00:00.000Z",
      blockNumber: "12",
      taskId: "1",
      agentId: 2,
      charterVersion: 1,
      descriptor: { class: "network_fetch", target: "examples.internal", argsHash: `0x${"ab".repeat(32)}` },
      payloadHash: `0x${"cd".repeat(32)}`,
      verdict: "BLOCK",
      reason: "target_not_allowlisted",
    });
    expect(gw.verdict).toBe("BLOCK");
    const iv = InterventionLine.parse({ type: "human_intervention", at: "t", action: "pause", proposalId: null, txHash: `0x${"ef".repeat(32)}`, blockNumber: "40", actor: "guardian" });
    expect(iv.action).toBe("pause");
  });
});
