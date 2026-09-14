import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export type RunTestsResult = { passed: boolean; output: string };

export type CommandResult = { code: number | null; output: string; timedOut: boolean };

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

    // Keep draining both pipes after the cap so a noisy child cannot deadlock on backpressure.
    let capturedBytes = 0;
    const capture = (chunk: Buffer): void => {
      const remaining = Math.max(0, 1024 * 1024 - capturedBytes);
      output += chunk.subarray(0, remaining).toString("utf8");
      capturedBytes += Math.min(chunk.byteLength, remaining);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", (err) => {
      settle({ code: null, output: `${output}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      settle({ code, output, timedOut });
    });
  });
}

/** Readiness only. A failed daemon check never enables host execution. */
export async function dockerAvailable(): Promise<boolean> {
  const result = await runCommand("docker", ["info"], { timeoutMs: 10_000 });
  return result.code === 0 && !result.timedOut;
}

export type SandboxTestOptions = {
  timeoutMs?: number;
  dependenciesVolume?: string;
  /** Injected by lifecycle tests; production uses the real Docker CLI. */
  commandRunner?: typeof runCommand;
};

/** Runs task-controlled code without network, host credentials or writable host mounts.
 *  The image must already be installed by the operator. Container and subprocess failures fail
 *  closed. Killing the Docker CLI does not kill its container, so always remove our unique
 *  container by name before returning, including on timeout or a failed startup. */
export async function dockerRunTests(dir: string, opts: SandboxTestOptions = {}): Promise<RunTestsResult> {
  const run = opts.commandRunner ?? runCommand;
  const source = resolve(dir);
  // --mount parses CSV. Refuse delimiters rather than letting a path add mount options.
  if (/[\n\r,"]/.test(source)) throw new Error("sandbox_invalid_workspace_path");
  if (opts.dependenciesVolume && !/^fleet-deps-[0-9a-f-]{36}$/.test(opts.dependenciesVolume)) throw new Error("sandbox_invalid_dependency_volume");
  const name = `fleet-tests-${randomUUID()}`;
  const args = [
    "run", "--rm", "--name", name, "--pull", "never",
    "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "65534:65534", "--pids-limit", "128", "--memory", "512m", "--cpus", "1",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
    "--mount", `type=bind,source=${source},target=/work,readonly`,
    ...(opts.dependenciesVolume ? ["--mount", `type=volume,source=${opts.dependenciesVolume},target=/work/node_modules,volume-subpath=node_modules,readonly`] : []),
    "--workdir", "/work", "--env", "HOME=/tmp", "--env", "npm_config_cache=/tmp/npm-cache",
    "node:22-alpine", "npm", "test",
  ];
  let result: CommandResult;
  try {
    result = await run("docker", args, { timeoutMs: opts.timeoutMs ?? 120_000 });
  } finally {
    const cleanup = await run("docker", ["rm", "--force", name], { timeoutMs: 10_000 });
    // --rm often removes the container before this command. Any other cleanup failure leaves
    // the run in doubt and must be surfaced, even if npm exited successfully.
    if (cleanup.timedOut || (cleanup.code !== 0 && !/no such container/i.test(cleanup.output))) {
      throw new Error(`sandbox_cleanup_failed: ${name}: ${cleanup.output}`);
    }
  }
  if (result.timedOut) throw new Error("sandbox_timeout: test container terminated");
  if (result.code === null || [125, 126, 127].includes(result.code)) {
    throw new Error(`sandbox_unavailable: ${result.output}`);
  }
  return { passed: result.code === 0, output: result.output };
}
