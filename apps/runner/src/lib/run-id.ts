import { resolveConfinedPath } from "./fs-safety.js";

/**
 * Every `[id]` route parameter and every direct caller of `resolveRunContext` must pass through
 * this allowlist before it ever reaches a filesystem path (fix round 1, F1): a crafted run id
 * (`..`, an absolute path, a `/` or `\` segment, a null byte, ...) must never let a route read or
 * write outside `experiments/reports`. Deliberately strict rather than merely "no `..`": only
 * `[A-Za-z0-9][A-Za-z0-9_.-]{0,63}` is accepted, which is also every legal `runId` this app itself
 * ever generates (`${experiment.name}-${Date.now()}`, `run-${Date.now()}`, both already matching).
 */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Returns `raw` unchanged when it matches the run id allowlist, `null` otherwise. Never echoes or
 *  transforms an invalid value; a caller reports a fixed `"invalid run id"` message, not this
 *  function's input. */
export function parseRunId(raw: string): string | null {
  return typeof raw === "string" && RUN_ID_PATTERN.test(raw) ? raw : null;
}

/**
 * Defense in depth beyond `parseRunId`'s allowlist (fix round 1, F1): confirms `<reportsDir>/<id>`
 * still resolves inside `reportsDir` using `fs-safety.ts`'s `resolveConfinedPath`, the same
 * lexical-plus-symlink-real-path check `fixtures-handler.ts` uses to confine a charter path.
 * Returns the confined, resolved run directory, or `null` when either the id fails the allowlist
 * or the resolved path would escape `reportsDir`.
 */
export function resolveConfinedRunDir(reportsDir: string, rawId: string): string | null {
  const runId = parseRunId(rawId);
  if (runId === null) return null;
  return resolveConfinedPath(reportsDir, runId);
}
