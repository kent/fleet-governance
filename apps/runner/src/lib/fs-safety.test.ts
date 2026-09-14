import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfinedPath } from "./fs-safety.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-fs-safety-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveConfinedPath", () => {
  it("resolves a plain relative path under root", () => {
    expect(resolveConfinedPath(dir, "run-1")).toBe(path.join(dir, "run-1"));
  });

  it("rejects a lexical .. escape", () => {
    expect(resolveConfinedPath(dir, "../outside")).toBeNull();
  });

  it("rejects a deeper .. escape hidden among normal segments", () => {
    expect(resolveConfinedPath(dir, "a/../../outside")).toBeNull();
  });

  it("rejects an absolute path", () => {
    expect(resolveConfinedPath(dir, "/etc/passwd")).toBeNull();
  });

  it("rejects a symlinked ancestor that points outside root", () => {
    const outside = mkdtempSync(path.join(tmpdir(), "fleet-fs-safety-outside-"));
    const linkPath = path.join(dir, "escape-link");
    symlinkSync(outside, linkPath);
    expect(resolveConfinedPath(dir, "escape-link/child")).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a path that does not exist yet, as long as it stays lexically under root", () => {
    mkdirSync(path.join(dir, "existing"));
    expect(resolveConfinedPath(dir, "existing/not-yet-created")).toBe(path.join(dir, "existing", "not-yet-created"));
  });
});
