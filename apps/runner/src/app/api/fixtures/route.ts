import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseFixtureFile } from "@fleet/schemas";
import { repoRoot } from "../../../lib/paths.js";

export type FixtureSummary = {
  name: string;
  kind: "scripted" | "model";
  description: string;
  charterPath?: string;
};

function listFixtures(dir: string, kind: "scripted" | "model"): FixtureSummary[] {
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
    if (fixture.schema === "fleet.fixture.model.v1") summary.charterPath = fixture.charter;
    out.push(summary);
  }
  return out;
}

/** `GET /api/fixtures`: the Scenario section's fixture list (controller notes item 8), read from
 *  `experiments/fixtures/scripted/*.json` and `experiments/fixtures/model/*.json` through
 *  `@fleet/schemas`'s `parseFixtureFile`. `fleet run` itself only knows scripted fixtures today
 *  (task 7 teaches it to resolve model fixtures by name); this route lists both so the panel can
 *  pass either name through the config. */
export async function GET(): Promise<Response> {
  const scripted = listFixtures(path.join(repoRoot, "experiments", "fixtures", "scripted"), "scripted");
  const model = listFixtures(path.join(repoRoot, "experiments", "fixtures", "model"), "model");
  return Response.json({ fixtures: [...scripted, ...model] });
}
