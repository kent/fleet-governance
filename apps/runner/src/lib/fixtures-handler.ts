import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { CharterV1, parseFixtureFile } from "@fleet/schemas";
import type { CharterV1 as CharterV1Type } from "@fleet/schemas";
import { resolveConfinedPath } from "./fs-safety.js";

const CHARTER_ESCAPE_ERROR = "charter path escapes the repository root";

/**
 * Confines a fixture's `charter` field to `repoRootDir`, defense in depth against a fixture whose
 * `charter` is absolute or contains a `..` segment (fixtures are repo-controlled data, but this
 * route reads whatever they name under `experiments/fixtures`). `fs-safety.ts`'s
 * `resolveConfinedPath` does the actual lexical-plus-symlink-real-path check (shared with fix
 * round 1's run id confinement, `run-id.ts`'s `resolveConfinedRunDir`); this wraps it only to keep
 * the fixed `CHARTER_ESCAPE_ERROR` message at the one call site that reports it (never the
 * resolved or original path, matching how `Workspace.resolvePath` never echoes a host path back).
 */
function resolveConfinedCharterPath(repoRootDir: string, charterPath: string): string | null {
  return resolveConfinedPath(repoRootDir, charterPath);
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
