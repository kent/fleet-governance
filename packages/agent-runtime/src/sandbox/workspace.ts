import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * One agent's private copy of a fixture repository, the only filesystem an agent's tool calls
 * ever touch. `dir` is always `<runDir>/agent-<agentId>`, so two agents sharing a `runDir` (one
 * task, run once per fleet member) never see each other's writes.
 *
 * Every path a caller passes to `readFile`/`writeFile` is resolved against `dir` and checked
 * before any real filesystem call: this is the confinement boundary the tool handlers in
 * `tools.ts` rely on rather than re-implementing themselves. A path that tries to leave the
 * workspace (a `..` segment, an absolute path, anything that resolves outside `dir`) is rejected
 * here, not discovered later as a stray read or write somewhere on the host.
 */
export class Workspace {
  readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Copies `repoFixtureDir` into `<runDir>/agent-<agentId>` and returns a `Workspace` rooted
   * there. `runDir` is created if it does not already exist; the per-agent directory is created
   * fresh by the copy itself.
   */
  static async fromFixture(repoFixtureDir: string, agentId: number, runDir: string): Promise<Workspace> {
    const dir = join(runDir, `agent-${agentId}`);
    await mkdir(runDir, { recursive: true });
    await cp(repoFixtureDir, dir, { recursive: true });
    return new Workspace(dir);
  }

  /**
   * Resolves `p` to an absolute path inside `dir`, or throws. Two independent checks, both
   * required: a textual scan for a `..` segment (so the rejection reason is legible in a test
   * failure or a log line) and, regardless of that scan's result, a check that the resolved
   * absolute path still falls under `dir` (so an absolute path, a redundant `./`, or any other
   * shape that never contains a literal `..` segment is caught the same way).
   */
  private resolvePath(p: string): string {
    if (typeof p !== "string" || p.length === 0) {
      throw new Error("Workspace: path must be a non-empty string");
    }
    const segments = p.split(/[/\\]/);
    if (segments.includes("..")) {
      throw new Error(`Workspace: path traversal ("..") is not allowed: ${p}`);
    }
    if (isAbsolute(p)) {
      throw new Error(`Workspace: absolute paths are not allowed: ${p}`);
    }

    const resolved = resolve(this.dir, p);
    const base = this.dir.endsWith(sep) ? this.dir : this.dir + sep;
    if (resolved !== this.dir && !resolved.startsWith(base)) {
      throw new Error(`Workspace: path escapes workspace: ${p}`);
    }
    return resolved;
  }

  async readFile(p: string): Promise<string> {
    return readFile(this.resolvePath(p), "utf8");
  }

  async writeFile(p: string, content: string): Promise<void> {
    const resolved = this.resolvePath(p);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
  }

  /** Every file under the workspace, as paths relative to `dir` with forward slashes, sorted.
   *  `node_modules` and `.git` are skipped: they are build/VCS noise an agent's tools never need
   *  to enumerate and can be large enough to make a full walk expensive for no benefit. */
  async listFiles(): Promise<string[]> {
    const results: string[] = [];

    const walk = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          results.push(relative(this.dir, full).split(sep).join("/"));
        }
      }
    };

    await walk(this.dir);
    return results.sort();
  }
}
