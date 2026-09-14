import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Injectable so `route.test.ts` can assert the exact argv without ever spawning a real process
 *  (controller notes item 7). Matches `node:child_process`'s `spawn` signature narrowed to what
 *  this module actually passes. */
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; detached: boolean; stdio: ["ignore", number, number]; env: NodeJS.ProcessEnv },
) => ChildProcess;

export type SpawnRunOptions = {
  runId: string;
  experimentPath: string;
  readSide: boolean;
  /** The "filesystem root" controller notes item 7 says to inject: every path this function
   *  touches (the run's report directory, the spawned child's `cwd`) is derived from this,
   *  never from the real repo root directly, so tests can point it at a temp directory. */
  repoRootDir: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: SpawnFn;
  /** Injectable resolution of `tsx/cli`'s real file path, defaulting to `defaultResolveTsxCli`.
   *  Tests supply a fixed string instead: `import.meta.resolve` (the production implementation
   *  needs, to avoid webpack statically bundling `tsx`'s whole CLI, see the comment on
   *  `defaultResolveTsxCli`) is a Node/webpack-runtime API Vitest's Vite-based transform does not
   *  implement. */
  resolveTsxCli?: () => string;
};

export type SpawnRunResult = { logPath: string; pid: number; argv: string[] };

/** The literal path (relative to the spawned child's `cwd`, `repoRootDir`) to `fleet run`'s CLI
 *  entry point, matching `apps/runner/README.md`'s documented invocation. */
const CLI_ENTRY_RELATIVE = "apps/runner/src/cli.ts";

/** A real ESM-native resolution (not `require.resolve`, which Next's bundler tries to trace and
 *  inline "tsx"'s whole CLI at build time since `tsx` ships ESM-only exports); this only ever
 *  needs to run at request time in the actual Node.js server runtime. */
function defaultResolveTsxCli(): string {
  return fileURLToPath(import.meta.resolve("tsx/cli"));
}

/**
 * Writes `<repoRootDir>/experiments/reports/<runId>/run.log`, then spawns `fleet run` as a
 * detached child with stdout and stderr redirected to that log file, matching controller notes
 * item 7: `spawn(process.execPath, [tsxCli, "apps/runner/src/cli.ts", "run", "--experiment",
 * experimentPath, "--run-id", runId, ...(readSide ? ["--readside"] : [])], { cwd: repoRoot,
 * detached: true, stdio: ["ignore", logFd, logFd], env })`, then `child.unref()`.
 */
export function spawnRun(opts: SpawnRunOptions): SpawnRunResult {
  const runDir = path.join(opts.repoRootDir, "experiments", "reports", opts.runId);
  mkdirSync(runDir, { recursive: true });
  const logPath = path.join(runDir, "run.log");
  const logFd = openSync(logPath, "a");

  const tsxCli = (opts.resolveTsxCli ?? defaultResolveTsxCli)();
  const argv = [
    tsxCli,
    CLI_ENTRY_RELATIVE,
    "run",
    "--experiment",
    opts.experimentPath,
    "--run-id",
    opts.runId,
    ...(opts.readSide ? ["--readside"] : []),
  ];

  const spawnFn = opts.spawnFn ?? nodeSpawn;
  const child = spawnFn(process.execPath, argv, {
    cwd: opts.repoRootDir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: opts.env,
  });
  child.unref();

  return { logPath, pid: child.pid ?? -1, argv: [process.execPath, ...argv] };
}
