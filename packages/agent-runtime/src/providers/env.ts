import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

/** `packages/agent-runtime/src/providers/env.ts` to the repo root is four directories up
 *  (`providers` -> `src` -> `agent-runtime` -> `packages`), the same distance from the built
 *  `dist/providers/env.js`, so this resolves correctly whether it runs from source or `dist`. */
const REPO_ROOT_ENV_PATH = fileURLToPath(new URL("../../../../.env", import.meta.url));

let dotenvLoaded = false;

/** Loads the gitignored repo-root `.env` via `dotenv` at most once per process, then reads
 *  `OPENROUTER_API_KEY`. This and the gated live smoke test are the only two places in this
 *  package that touch `.env` or `dotenv` (controller notes): unit tests construct
 *  `OpenRouterProvider` with a fake key and never call this. Throws naming the variable only,
 *  never a value, so a missing key cannot leak through an error message or a log. */
export function readOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string {
  if (!dotenvLoaded) {
    if (existsSync(REPO_ROOT_ENV_PATH)) {
      loadDotenv({ path: REPO_ROOT_ENV_PATH });
    }
    dotenvLoaded = true;
  }
  const key = env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not set (expected in the repo-root .env for local runs)");
  }
  return key;
}
