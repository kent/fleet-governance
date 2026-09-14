import { spawn } from "node:child_process";

export type RunTestsResult = { passed: boolean; output: string };

type CommandResult = { code: number | null; output: string; timedOut: boolean };

/**
 * Runs one command to completion, capturing combined stdout+stderr and enforcing `timeoutMs`
 * (SIGKILL on timeout). Never rejects: a spawn failure (missing binary, permission error) comes
 * back as `code: null` with the error message folded into `output`, the same shape a timeout or
 * a non-zero exit produces, so every caller has exactly one place to check for success
 * (`code === 0 && !timedOut`).
 */
export function runCommand(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, opts.cwd ? { cwd: opts.cwd } : {});
    let output = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      settle({ code: null, output: `${output}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      settle({ code, output, timedOut });
    });
  });
}

/** Whether Docker is reachable at all, spec's definition of "Docker is unavailable" for
 *  `run_tests`'s fallback: `docker info` exits non-zero (daemon not running, no permission, the
 *  binary is missing and spawn itself errors). */
export async function dockerAvailable(): Promise<boolean> {
  const result = await runCommand("docker", ["info"], { timeoutMs: 10_000 });
  return result.code === 0 && !result.timedOut;
}

/**
 * `docker run --rm --network none -v <dir>:/work -w /work node:22-alpine npm test`, 120s
 * timeout. Throws when Docker is unavailable (`docker info` failed) so `ToolRouter.runTests` can
 * catch that specific failure mode and fall back to an in-process `npm test`; any other failure
 * (the container ran but the suite failed, non-zero exit) is reported as `passed: false` with
 * the captured output, not a throw, since Docker itself worked fine in that case.
 */
export async function dockerRunTests(dir: string): Promise<RunTestsResult> {
  const available = await dockerAvailable();
  if (!available) {
    throw new Error("docker unavailable: `docker info` failed");
  }

  const result = await runCommand(
    "docker",
    ["run", "--rm", "--network", "none", "-v", `${dir}:/work`, "-w", "/work", "node:22-alpine", "npm", "test"],
    { timeoutMs: 120_000 },
  );
  return { passed: result.code === 0 && !result.timedOut, output: result.output };
}

/** Fallback used when Docker is unavailable: `npm test` run directly in `dir`, with no
 *  container and so no `--network none` isolation; the caller is responsible for noting that
 *  loss of isolation in its log and report (the `fallback: "no-docker"` marker in
 *  `ToolRouter`'s `run_tests` output). Same 120s timeout as the Docker path. */
export async function npmTestInProcess(dir: string): Promise<RunTestsResult> {
  const result = await runCommand("npm", ["test"], { cwd: dir, timeoutMs: 120_000 });
  return { passed: result.code === 0 && !result.timedOut, output: result.output };
}
