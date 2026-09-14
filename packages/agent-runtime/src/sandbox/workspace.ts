import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** `fs.cp`'s per-entry filter (F1/M8): skips `node_modules` and `.git` entirely (build/VCS
 *  noise an agent's tools never need), and skips every symlink. A symlink is never copied in,
 *  followed or not: `Workspace` has no legitimate use for one, and copying one in (`cp`'s
 *  default behavior preserves them) would let an ALLOWed `read_repo`/`write_repo` reach whatever
 *  the link points to, including outside the workspace entirely. */
async function shouldCopyIntoWorkspace(source: string): Promise<boolean> {
  const name = basename(source);
  if (name === "node_modules" || name === ".git") return false;
  const stats = await lstat(source);
  return !stats.isSymbolicLink();
}

/**
 * One agent's private copy of a fixture repository, the only filesystem an agent's tool calls
 * ever touch. `dir` is always `<runDir>/agent-<agentId>`, so two agents sharing a `runDir` (one
 * task, run once per fleet member) never see each other's writes.
 *
 * Every path a caller passes to `readFile`/`writeFile` is resolved against `dir` and checked
 * before any real filesystem call: this is the confinement boundary the tool handlers in
 * `tools.ts` rely on rather than re-implementing themselves. A path that tries to leave the
 * workspace (a `..` segment, an absolute path, anything that resolves outside `dir`, or a
 * symlink anywhere along the way) is rejected here, not discovered later as a stray read or
 * write somewhere on the host.
 */
export class Workspace {
  readonly dir: string;
  private readonly realDir: string;

  private constructor(dir: string, realDir: string) {
    this.dir = dir;
    this.realDir = realDir;
  }

  /**
   * Copies `repoFixtureDir` into `<runDir>/agent-<agentId>` and returns a `Workspace` rooted
   * there, skipping every symlink, `node_modules`, and `.git` on the way in (F1/M8). `runDir` is
   * created if it does not already exist; the per-agent directory is created fresh by the copy
   * itself.
   *
   * `realDir` is this workspace's own root, `realpath`'d once here (macOS maps `/tmp` under
   * `/private/tmp`, and every later confinement check needs to compare against the same real
   * path a filesystem lookup will actually resolve, not the lexical one).
   */
  static async fromFixture(repoFixtureDir: string, agentId: number, runDir: string): Promise<Workspace> {
    const dir = join(runDir, `agent-${agentId}`);
    await mkdir(runDir, { recursive: true });
    await cp(repoFixtureDir, dir, { recursive: true, filter: shouldCopyIntoWorkspace });
    const realDir = await realpath(dir);
    return new Workspace(dir, realDir);
  }

  /**
   * Resolves `p` to an absolute path inside `dir`, or throws. Lexical checks first (cheap, and
   * legible in a test failure or a log line): a `..` segment, or an absolute path. Then a
   * filesystem-aware check (F1), because the lexical checks alone cannot see a symlink: walks up
   * from the resolved path to its deepest *existing* ancestor, `realpath`s that ancestor (which
   * follows every symlink along the way, including one at the resolved path itself if it
   * exists), and requires the result to fall under `this.realDir`. Finally, if the resolved path
   * itself already exists, `lstat`s it (which does not follow a final symlink) and rejects
   * outright if it is one, even one whose target happens to resolve inside the workspace: this
   * sandbox has no legitimate use for symlinks at all, so any encountered here is treated as
   * suspicious rather than laboriously re-verified.
   */
  private async resolvePath(p: string): Promise<string> {
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
    const lexicalBase = this.dir.endsWith(sep) ? this.dir : this.dir + sep;
    if (resolved !== this.dir && !resolved.startsWith(lexicalBase)) {
      throw new Error(`Workspace: path escapes workspace: ${p}`);
    }

    await this.assertRealpathConfined(resolved, p);
    return resolved;
  }

  private async assertRealpathConfined(resolved: string, original: string): Promise<void> {
    const realBase = this.realDir.endsWith(sep) ? this.realDir : this.realDir + sep;

    let ancestor = resolved;
    for (;;) {
      try {
        const real = await realpath(ancestor);
        if (real !== this.realDir && !(real + sep).startsWith(realBase)) {
          throw new Error(`Workspace: path escapes workspace: ${original}`);
        }
        break;
      } catch (err) {
        if (isEnoent(err)) {
          const parent = dirname(ancestor);
          if (parent === ancestor) {
            throw new Error(`Workspace: path escapes workspace: ${original}`);
          }
          ancestor = parent;
          continue;
        }
        throw err;
      }
    }

    try {
      const stats = await lstat(resolved);
      if (stats.isSymbolicLink()) {
        throw new Error(`Workspace: path escapes workspace: ${original}`);
      }
    } catch (err) {
      if (!isEnoent(err)) throw err;
      // Does not exist yet: a normal new-file write. Nothing further to check.
    }
  }

  async readFile(p: string): Promise<string> {
    return readFile(await this.resolvePath(p), "utf8");
  }

  async writeFile(p: string, content: string): Promise<void> {
    const resolved = await this.resolvePath(p);
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
