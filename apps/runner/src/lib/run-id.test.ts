import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRunId, resolveConfinedRunDir } from "./run-id.js";

describe("parseRunId", () => {
  it("accepts a normal run id", () => {
    expect(parseRunId("local-run-1789391778139")).toBe("local-run-1789391778139");
  });

  it("accepts the two shapes this app itself generates", () => {
    expect(parseRunId("hf-replay-1789391778139")).toBe("hf-replay-1789391778139");
    expect(parseRunId("run-1789391778139")).toBe("run-1789391778139");
  });

  it.each([
    ["..", ".."],
    ["../../etc/passwd", "../../etc/passwd"],
    ["a/b", "a/b"],
    ["a%2fb", "a%2fb"],
    ["", "empty string"],
    ["a\\b", "backslash"],
    ["a\0b", "null byte"],
    ["/etc/passwd", "absolute path"],
    [".", "a bare dot"],
    ["-leading-dash", "leading dash (must start alnum)"],
  ])("rejects %j (%s)", (raw) => {
    expect(parseRunId(raw)).toBeNull();
  });

  it("rejects a run id longer than 64 characters", () => {
    expect(parseRunId("a".repeat(65))).toBeNull();
  });

  it("accepts a run id exactly 64 characters long", () => {
    expect(parseRunId("a".repeat(64))).toBe("a".repeat(64));
  });
});

describe("resolveConfinedRunDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fleet-run-id-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a normal id to <reportsDir>/<id>", () => {
    expect(resolveConfinedRunDir(dir, "run-1")).toBe(path.join(dir, "run-1"));
  });

  it("rejects an id that fails the allowlist before ever touching the filesystem", () => {
    expect(resolveConfinedRunDir(dir, "../../etc/passwd")).toBeNull();
    expect(resolveConfinedRunDir(dir, "a/b")).toBeNull();
    expect(resolveConfinedRunDir(dir, "")).toBeNull();
  });
});
