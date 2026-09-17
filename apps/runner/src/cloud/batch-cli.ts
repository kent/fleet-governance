import { appendFileSync } from "node:fs";
import { tickBatch, beginBatchRetirement, releaseBatchAllocation, completeBatchRetirement } from "./batch-runner.js";
import { safeFailure } from "./simulation-diagnostics.js";

try {
  if (process.env.GITHUB_REPOSITORY !== "kent/fleet-governance" || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_ACTIONS !== "true") throw new Error("Batch administration runs only in the main-branch GitHub workflow.");
  const command = process.argv[2];
  if (command === "tick") {
    const result = await tickBatch();
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `action=${result.action}\n`);
    console.log(JSON.stringify(result));
  } else if (command === "begin-retirement") {
    const record = await beginBatchRetirement();
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `IMAGE_RUNNER=${record.image}\n`);
    console.log(JSON.stringify({ runId: record.runId, allocationId: record.allocationId, phase: "retiring" }));
  } else if (command === "release") await releaseBatchAllocation();
  else if (command === "complete-retirement") await completeBatchRetirement();
  else throw new Error("Unknown batch operation.");
} catch (error) {
  // RPC errors include private endpoint URLs and request bodies. Never let Node
  // print the raw rejection into a public Actions log.
  console.error(JSON.stringify({ event: "batch_administration_failed", failure: safeFailure(error) }));
  process.exitCode = 1;
}
