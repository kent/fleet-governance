import { listAllFixtures } from "../../../lib/fixtures-handler.js";
import { repoRoot } from "../../../lib/paths.js";

/** `GET /api/fixtures`: the Scenario section's fixture list (controller notes item 8), read from
 *  `experiments/fixtures/scripted/*.json` and `experiments/fixtures/model/*.json`. The actual
 *  logic lives in `src/lib/fixtures-handler.ts` (see the comment there for why). */
export async function GET(): Promise<Response> {
  return Response.json({ fixtures: listAllFixtures(repoRoot) });
}
