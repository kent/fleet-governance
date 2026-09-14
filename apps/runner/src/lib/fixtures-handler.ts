import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { CharterV1, parseFixtureFile } from "@fleet/schemas";
import type { CharterV1 as CharterV1Type } from "@fleet/schemas";

const CHARTER_ESCAPE_ERROR = "charter path escapes the repository root";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Confines a fixture's `charter` field to `repoRootDir`, defense in depth against a fixture whose
 * `charter` is absolute or contains a `..` segment (fixtures are repo-controlled data, but this
 * route reads whatever they name under `experiments/fixtures`), mirroring
 * `packages/agent-runtime/src/sandbox/workspace.ts`'s `Workspace.resolvePath`: resolve lexically
 * first, reject if `path.relative` from the lexically-resolved repo root starts with `".."` or is
 * itself absolute, then separately (real path to real path, so a symlinked ancestor of
 * `repoRootDir` itself cannot produce a false escape) walk up from the resolved path to its
 * deepest existing ancestor and require that ancestor's `realpath` to still fall under the root's
 * own `realpath`, so a symlink anywhere along the way that points outside the root is caught too,
 * not just a lexical `..`. Returns the resolved path to read, or `null` when it escapes (the
 * caller reports `CHARTER_ESCAPE_ERROR`, never the resolved or original path, matching how
 * `Workspace` never echoes a host path back).
 */
function resolveConfinedCharterPath(repoRootDir: string, charterPath: string): string | null {
  // Lexical check first, against `repoRootDir` itself only `path.resolve`d (not `realpath`d: a
  // symlinked ancestor of `repoRootDir`, e.g. macOS's /var -> /private/var under `os.tmpdir()`,
  // must not make an otherwise-valid path look like it escapes just because one side of the
  // comparison is real and the other lexical).
  const lexicalRoot = path.resolve(repoRootDir);
  const resolved = path.resolve(repoRootDir, charterPath);

  const rel = path.relative(lexicalRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;

  // Then the symlink-aware check: realpath of the deepest existing ancestor must still fall
  // under the root's own realpath, entirely real-to-real so it is unaffected by the above.
  const realRoot = realpathSync(repoRootDir);
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  let ancestor = resolved;
  for (;;) {
    try {
      const real = realpathSync(ancestor);
      if (real !== realRoot && !(real + path.sep).startsWith(rootWithSep)) return null;
      break;
    } catch (err) {
      if (!isEnoent(err)) throw err;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }

  return resolved;
}

/**
 * `GET /api/fixtures`'s actual logic, kept out of `app/api/fixtures/route.ts` on purpose (same
 * reason as `runs-handler.ts`: Next's generated route types reject any export from a `route.ts`
 * file other than the HTTP method handlers it recognizes) and parameterized on `repoRootDir` so
 * `route.fixtures.test.ts` can point it at a temp directory instead of the real repo tree.
 */
export type FixtureSummary = {
  name: string;
  kind: "scripted" | "model";
  description: string;
  charterPath?: string;
  /** The parsed, `CharterV1`-validated charter for a model fixture, read server-side from its own
   *  `charterPath` (fix round 1: every model fixture used to be pre-filled from the same literal
   *  `coding-task.v1.json` regardless of which charter it actually named). Absent when the fixture
   *  is scripted (scripted fixtures name no charter of their own) or when reading/parsing failed,
   *  in which case `charterError` explains why. */
  charter?: CharterV1Type;
  charterError?: string;
};

function readCharter(repoRootDir: string, charterPath: string): { charter?: CharterV1Type; charterError?: string } {
  const fullPath = resolveConfinedCharterPath(repoRootDir, charterPath);
  if (fullPath === null) {
    return { charterError: CHARTER_ESCAPE_ERROR };
  }
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch (err) {
    return { charterError: `could not read charter at ${charterPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { charterError: `charter at ${charterPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const result = CharterV1.safeParse(json);
  if (!result.success) {
    return { charterError: `charter at ${charterPath} does not parse as fleet.charter.v1: ${result.error.message}` };
  }
  return { charter: result.data };
}

function listFixtures(repoRootDir: string, dir: string, kind: "scripted" | "model"): FixtureSummary[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const out: FixtureSummary[] = [];
  for (const file of files) {
    const json: unknown = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const fixture = parseFixtureFile(json);
    const summary: FixtureSummary = { name: fixture.name, kind, description: fixture.description };
    if (fixture.schema === "fleet.fixture.model.v1") {
      summary.charterPath = fixture.charter;
      const { charter, charterError } = readCharter(repoRootDir, fixture.charter);
      if (charter) summary.charter = charter;
      if (charterError) summary.charterError = charterError;
    }
    out.push(summary);
  }
  return out;
}

/** Lists every fixture under `<repoRootDir>/experiments/fixtures/{scripted,model}/*.json`, each
 *  model fixture carrying its own parsed `charter` (or a `charterError` explaining why it could
 *  not be loaded). Scripted fixtures never carry a charter of their own: the panel pre-fills those
 *  from the embedded default (`lib/defaults.ts`'s `CODING_TASK_CHARTER`). */
export function listAllFixtures(repoRootDir: string): FixtureSummary[] {
  const scripted = listFixtures(repoRootDir, path.join(repoRootDir, "experiments", "fixtures", "scripted"), "scripted");
  const model = listFixtures(repoRootDir, path.join(repoRootDir, "experiments", "fixtures", "model"), "model");
  return [...scripted, ...model];
}
