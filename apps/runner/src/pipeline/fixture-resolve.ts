import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFixtureFile } from "@fleet/schemas";
import type { FixtureAnyV1, FixtureV1, ModelFixtureV1 } from "@fleet/schemas";
import { RunnerEnvError } from "../env.js";

/** The two directories a fixture can live in. `scripted/` is searched first by default; a caller
 *  that knows which kind it wants says so with `prefer`, which matters because two fixtures have
 *  the same name in both directories (`hf-replay` and `legit-amendment`), one scripted and one
 *  model driven, on purpose: they are the same scenario run two ways. */
export const FIXTURE_SUBDIRS = ["scripted", "model"] as const;
export type FixtureKind = (typeof FIXTURE_SUBDIRS)[number];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Which of the two `fleet.fixture.*` shapes a resolved fixture is, as the word `scenario` uses. */
export function fixtureKind(fixture: FixtureAnyV1): FixtureKind {
  return fixture.schema === "fleet.fixture.model.v1" ? "model" : "scripted";
}

export function isModelFixture(fixture: FixtureAnyV1): fixture is ModelFixtureV1 {
  return fixture.schema === "fleet.fixture.model.v1";
}

export function isScriptedFixture(fixture: FixtureAnyV1): fixture is FixtureV1 {
  return fixture.schema === "fleet.fixture.v1";
}

/**
 * Finds one fixture by name under a fixtures root (`experiments/fixtures`), looking in
 * `scripted/<name>.json` and `model/<name>.json`, and parses it through `parseFixtureFile`, which
 * discriminates on the file's own `schema` literal. The caller gets whichever of the two shapes
 * the file actually is; nothing here guesses from the directory it was found in, so a file
 * misfiled under the wrong directory fails on its schema rather than being read as the other kind.
 *
 * `prefer` decides which directory is searched first, and it matters: `hf-replay` and
 * `legit-amendment` each exist twice, as a scripted fixture and as a model fixture of the same
 * scenario. The experiment's `scenario.agentsScripted` is what picks between them, so a run that
 * says "not scripted" gets the model variant rather than the scripted one that happens to sort
 * first. A name that exists in only one directory resolves to it either way, and
 * `assertScenarioMatchesFixture` then reports the disagreement.
 *
 * Throws `RunnerEnvError` naming both paths searched when the name matches neither, and naming the
 * file when it does not parse.
 */
export function resolveFixture(
  fixturesRoot: string,
  name: string,
  opts: { prefer?: FixtureKind } = {},
): { fixture: FixtureAnyV1; filePath: string } {
  const order: readonly FixtureKind[] =
    opts.prefer === "model" ? ["model", "scripted"] : opts.prefer === "scripted" ? ["scripted", "model"] : FIXTURE_SUBDIRS;
  const candidates = order.map((sub) => path.join(fixturesRoot, sub, `${name}.json`));
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (!filePath) {
    throw new RunnerEnvError(`fixture "${name}" not found; looked for ${candidates.join(" and ")}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new RunnerEnvError(`fixture at ${filePath} is not valid JSON: ${errorMessage(err)}`);
  }

  try {
    return { fixture: parseFixtureFile(json), filePath };
  } catch (err) {
    throw new RunnerEnvError(`fixture at ${filePath} does not parse as a fleet fixture: ${errorMessage(err)}`);
  }
}

/**
 * The experiment's own claim about its fixture against the fixture itself. `scenario.agentsScripted`
 * decides which branch `AGENTS_RUNNING` takes, so a config that says `true` over a model fixture
 * would drive a scripted run against a file that has no trigger and no vote script, and one that
 * says `false` over a scripted fixture would start model agents with no charter file to open the
 * task with. Neither is recoverable at the point it would be discovered, so PREFLIGHT refuses
 * both, naming what disagrees.
 */
export function assertScenarioMatchesFixture(fixture: FixtureAnyV1, agentsScripted: boolean, fixtureName: string): void {
  const kind = fixtureKind(fixture);
  const expected: FixtureKind = agentsScripted ? "scripted" : "model";
  if (kind !== expected) {
    throw new RunnerEnvError(
      `fixture "${fixtureName}" is a ${kind} fixture (${fixture.schema}), but scenario.agentsScripted is ${String(agentsScripted)}, which means a ${expected} fixture`,
    );
  }
}
