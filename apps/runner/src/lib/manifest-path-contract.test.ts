import path from "node:path";
import { describe, expect, it } from "vitest";
import { manifestPathsForRun } from "../pipeline/run-pipeline.js";

/**
 * `apps/runner/src/lib/run-context.ts` carries its own copy of `manifestPathsForRun` because
 * importing the pipeline module into a file the Next build collects pulls in `@fleet/agent-runtime`'s
 * barrel and breaks page-data collection. The duplication is deliberate and documented at both
 * sites, but nothing made the two fail together, so this pins the shape the UI's copy assumes.
 *
 * If this test fails, `fleet run` changed where it writes a run's manifest. Update
 * `run-context.ts`'s copy to match in the same change, or the live run view and the guardian
 * controls silently lose the manifest for the whole run (that is the defect this pin exists to
 * prevent recurring, Task 6 fix round 1, F6).
 */
describe("manifest path contract between the pipeline and the Runner UI", () => {
  it("writes a run's manifest under <deployments>/<chainId>/ as latest.json and run-<runId>.json", () => {
    const deploymentsDir = path.join("/tmp", "deployments");
    const paths = manifestPathsForRun(deploymentsDir, 31337, "run-live");

    expect(paths.latest).toBe(path.join(deploymentsDir, "31337", "latest.json"));
    expect(paths.perRun).toBe(path.join(deploymentsDir, "31337", "run-run-live.json"));
  });

  it("keeps the chain id as a plain decimal directory name", () => {
    expect(manifestPathsForRun("/d", 84532, "r").latest).toBe(path.join("/d", "84532", "latest.json"));
  });
});
