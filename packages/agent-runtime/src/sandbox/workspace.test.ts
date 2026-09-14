import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "./workspace.js";

let fixtureDir: string;
let runDir: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "fleet-fixture-"));
  runDir = await mkdtemp(join(tmpdir(), "fleet-run-"));

  await fsWriteFile(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture-repo", version: "1.0.0" }));
  await mkdir(join(fixtureDir, "src"), { recursive: true });
  await fsWriteFile(join(fixtureDir, "src", "index.ts"), "export const answer = 42;\n");
  await mkdir(join(fixtureDir, "test"), { recursive: true });
  await fsWriteFile(join(fixtureDir, "test", "index.test.ts"), "// placeholder test\n");
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });
});

describe("Workspace.fromFixture", () => {
  it("copies the fixture repository into a per-agent directory under runDir", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 3, runDir);
    expect(workspace.dir).toBe(join(runDir, "agent-3"));

    const copied = await readFile(join(workspace.dir, "src", "index.ts"), "utf8");
    expect(copied).toBe("export const answer = 42;\n");
  });

  it("gives two agents in the same runDir separate directories", async () => {
    const first = await Workspace.fromFixture(fixtureDir, 1, runDir);
    const second = await Workspace.fromFixture(fixtureDir, 2, runDir);
    expect(first.dir).not.toBe(second.dir);

    await first.writeFile("src/only-in-first.ts", "// only in first\n");
    await expect(second.readFile("src/only-in-first.ts")).rejects.toThrow();
  });
});

describe("Workspace.readFile / writeFile", () => {
  it("round-trips a file written under the workspace", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await workspace.writeFile("src/new-file.ts", "export const hello = 1;\n");
    expect(await workspace.readFile("src/new-file.ts")).toBe("export const hello = 1;\n");
  });

  it("creates intermediate directories on write", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await workspace.writeFile("src/nested/dir/file.ts", "// nested\n");
    expect(await workspace.readFile("src/nested/dir/file.ts")).toBe("// nested\n");
  });

  it("rejects a path containing a .. traversal segment", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await expect(workspace.readFile("../outside.ts")).rejects.toThrow(/traversal|escapes/i);
    await expect(workspace.writeFile("src/../../outside.ts", "x")).rejects.toThrow(/traversal|escapes/i);
  });

  it("rejects an absolute path even when it does not textually contain ..", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await expect(workspace.readFile("/etc/passwd")).rejects.toThrow();
  });

  it("never touches anything outside the workspace directory even under traversal attempts", async () => {
    const outsideMarker = join(runDir, "..", `outside-marker-${Date.now()}.txt`);
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await expect(workspace.writeFile("../../../../../../../../tmp-marker.txt", "x")).rejects.toThrow();
    await expect(readFile(outsideMarker, "utf8")).rejects.toThrow();
  });
});

describe("Workspace.listFiles", () => {
  it("lists every file under the workspace as a relative posix path", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    const files = await workspace.listFiles();
    expect(files).toContain("package.json");
    expect(files).toContain("src/index.ts");
    expect(files).toContain("test/index.test.ts");
  });

  it("reflects a file written after fromFixture", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await workspace.writeFile("src/added.ts", "// added\n");
    const files = await workspace.listFiles();
    expect(files).toContain("src/added.ts");
  });
});

describe("Workspace: symlinks are refused (F1)", () => {
  let outsideDir: string;
  let outsideFileDir: string;
  let outsideFile: string;

  beforeEach(async () => {
    outsideDir = await mkdtemp(join(tmpdir(), "fleet-outside-dir-"));
    await fsWriteFile(join(outsideDir, "secret.txt"), "outside directory content\n");

    outsideFileDir = await mkdtemp(join(tmpdir(), "fleet-outside-file-"));
    outsideFile = join(outsideFileDir, "secret2.txt");
    await fsWriteFile(outsideFile, "outside file content\n");

    await symlink(outsideDir, join(fixtureDir, "escape-dir"), "dir");
    await symlink(outsideFile, join(fixtureDir, "escape-file"), "file");
  });

  afterEach(async () => {
    await rm(outsideDir, { recursive: true, force: true });
    await rm(outsideFileDir, { recursive: true, force: true });
  });

  it("does not copy either symlink into the workspace", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await expect(lstat(join(workspace.dir, "escape-dir"))).rejects.toThrow();
    await expect(lstat(join(workspace.dir, "escape-file"))).rejects.toThrow();
  });

  it("refuses to read through a symlink to a directory outside the workspace (defense in depth, independent of the copy filter)", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await symlink(outsideDir, join(workspace.dir, "later-escape-dir"), "dir");
    await expect(workspace.readFile("later-escape-dir/secret.txt")).rejects.toThrow(/escapes/i);
  });

  it("refuses to read or write through a symlink to a file outside the workspace", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await symlink(outsideFile, join(workspace.dir, "later-escape-file"), "file");
    await expect(workspace.readFile("later-escape-file")).rejects.toThrow(/escapes/i);
    await expect(workspace.writeFile("later-escape-file", "overwritten")).rejects.toThrow(/escapes/i);
    expect(await readFile(outsideFile, "utf8")).toBe("outside file content\n");
  });

  it("refuses a symlink even when its own target resolves inside the workspace", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await symlink(join(workspace.dir, "src", "index.ts"), join(workspace.dir, "src", "internal-link.ts"), "file");
    await expect(workspace.readFile("src/internal-link.ts")).rejects.toThrow(/escapes/i);
  });

  it("still allows a normal new-file write whose parent exists but whose file does not", async () => {
    const workspace = await Workspace.fromFixture(fixtureDir, 1, runDir);
    await workspace.writeFile("src/brand-new.ts", "// new\n");
    expect(await workspace.readFile("src/brand-new.ts")).toBe("// new\n");
  });
});
