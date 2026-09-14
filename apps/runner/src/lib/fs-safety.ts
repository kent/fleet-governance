import { realpathSync } from "node:fs";
import path from "node:path";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** `realpathSync` of the deepest existing ancestor of `target` (`target` itself, if it exists).
 *  Used for both `rootDir` and the resolved candidate path, since neither is guaranteed to exist
 *  yet (a run's own report directory, in particular, does not exist before its first write); when
 *  nothing on a path exists yet there is no symlink on it to worry about, so walking up to
 *  whatever does exist is the correct "real" anchor for the comparison, not an escape hatch. */
function nearestExistingRealpath(target: string): string {
  let ancestor = target;
  for (;;) {
    try {
      return realpathSync(ancestor);
    } catch (err) {
      if (!isEnoent(err)) throw err;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw err;
      ancestor = parent;
    }
  }
}

/**
 * Confines `relativePath` under `rootDir`, defense in depth against a path segment that is
 * absolute or contains a `..` component (originally written for a fixture's `charter` field,
 * fixture files being repo-controlled data but this route reading whatever they name under
 * `experiments/fixtures`; task 6 fix round 1 reuses it, generalized, to confine a run id under
 * `experiments/reports` too). Mirrors `packages/agent-runtime/src/sandbox/workspace.ts`'s
 * `Workspace.resolvePath`: resolve lexically first, reject if `path.relative` from the
 * lexically-resolved root starts with `".."` or is itself absolute, then separately (real path to
 * real path, so a symlinked ancestor of `rootDir` itself cannot produce a false escape) walk up
 * from the resolved path to its deepest existing ancestor and require that ancestor's `realpath`
 * to still fall under the root's own `realpath`, so a symlink anywhere along the way that points
 * outside the root is caught too, not just a lexical `..`. Returns the resolved path, or `null`
 * when it escapes; callers report a fixed message, never the resolved or original path, matching
 * how `Workspace` never echoes a host path back.
 */
export function resolveConfinedPath(rootDir: string, relativePath: string): string | null {
  // Lexical check first, against `rootDir` itself only `path.resolve`d (not `realpath`d: a
  // symlinked ancestor of `rootDir`, e.g. macOS's /var -> /private/var under `os.tmpdir()`, must
  // not make an otherwise-valid path look like it escapes just because one side of the comparison
  // is real and the other lexical).
  const lexicalRoot = path.resolve(rootDir);
  const resolved = path.resolve(rootDir, relativePath);

  const rel = path.relative(lexicalRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  // Then the symlink-aware check: realpath of the deepest existing ancestor of the candidate must
  // still fall under the deepest existing ancestor of `rootDir` itself, entirely real-to-real so
  // it is unaffected by the above. Neither `rootDir` nor `resolved` need exist yet (a run's own
  // report directory does not exist before its first write); `nearestExistingRealpath` walks up
  // to whatever does.
  const realRoot = nearestExistingRealpath(lexicalRoot);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const real = nearestExistingRealpath(resolved);
  if (real !== realRoot && !(real + path.sep).startsWith(rootWithSep)) return null;

  return resolved;
}
