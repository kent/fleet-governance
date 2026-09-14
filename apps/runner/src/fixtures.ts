import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FixtureV1 } from "@fleet/schemas";
import type { FixtureV1 as FixtureV1Type } from "@fleet/schemas";
import { RunnerEnvError } from "./env.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads and validates one `fleet.fixture.v1` file off disk. Throws `RunnerEnvError` on any
 *  failure (missing file, invalid JSON, or a shape that does not parse as `FixtureV1`). */
export function loadFixture(filePath: string): FixtureV1Type {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new RunnerEnvError(`could not read fixture at ${filePath}: ${errorMessage(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new RunnerEnvError(`fixture at ${filePath} is not valid JSON: ${errorMessage(err)}`);
  }
  const result = FixtureV1.safeParse(json);
  if (!result.success) {
    throw new RunnerEnvError(`fixture at ${filePath} does not parse as fleet.fixture.v1: ${result.error.message}`);
  }
  return result.data;
}

/** Loads every `*.json` file directly under `dir` as a `FixtureV1`, sorted by filename for a
 *  deterministic order. Throws on the first file that fails to parse. */
export function loadScriptedFixtures(dir: string): FixtureV1Type[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => loadFixture(path.join(dir, f)));
}

/** The order `fleet demo` runs the eight spec 15.3 scenario fixtures in (task 8 brief's own
 *  listing order): a defeated deviation, a passed amendment, a visible delegation, a rejected
 *  impostor, a guardian intervention, a late vote, three workers unavailable, and two colluding
 *  workers. Demo fixtures are looked up by this exact list of `name`s, not directory order, so
 *  the sequence stays stable even if more fixture files are added under the directory later. */
export const DEMO_FIXTURE_ORDER = [
  "hf-replay",
  "legit-amendment",
  "delegation-visible",
  "impostor",
  "guardian-cancel",
  "late-vote",
  "three-unavailable",
  "two-colluding",
] as const;

/** Loads exactly the `DEMO_FIXTURE_ORDER` fixtures from `dir`, in that order. Throws
 *  `RunnerEnvError` naming any fixture from the list that is missing. */
export function loadDemoFixtures(dir: string): FixtureV1Type[] {
  const byName = new Map(loadScriptedFixtures(dir).map((f) => [f.name, f]));
  return DEMO_FIXTURE_ORDER.map((name) => {
    const fixture = byName.get(name);
    if (!fixture) {
      throw new RunnerEnvError(`demo fixture "${name}" not found under ${dir}`);
    }
    return fixture;
  });
}
