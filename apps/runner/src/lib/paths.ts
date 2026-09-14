import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/** apps/runner/src/lib -> apps/runner/src -> apps/runner -> apps -> repo root. Every route
 *  handler's default dependencies derive `experiments/configs`, `deployments/configs`,
 *  `experiments/reports`, and the spawned child's `cwd` from this one value; tests override it by
 *  passing a different `repoRootDir` into the handler rather than importing this constant. */
export const repoRoot = path.resolve(currentDir, "../../../..");
