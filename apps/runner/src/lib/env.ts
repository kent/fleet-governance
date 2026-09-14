import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { repoRoot } from "./paths.js";

let loaded = false;

/**
 * Loads the repo-root `.env` file into `process.env` exactly once per process, called from every
 * route handler before it reads `process.env`, so the detached child `fleet run` spawns (which
 * inherits `process.env` verbatim) sees the same keys the handler checked presence of. Idempotent
 * and side-effect-free on later calls. Never reads, logs, returns, or otherwise exposes any
 * variable's value: `dotenv.config` only mutates `process.env` in place.
 */
export function loadRunnerEnv(): void {
  if (loaded) return;
  loadDotenv({ path: path.join(repoRoot, ".env") });
  loaded = true;
}
