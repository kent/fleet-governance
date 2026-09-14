import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunRecordDocument } from "./pipeline/record.js";

/**
 * `fleet demo` end-to-end integration test (task 8 brief, step 3): a fresh Anvil, `fleet demo
 * --fresh-anvil` (no read side, so this needs no Docker), asserting exit 0, that `record.json`
 * covers all eight fixtures, and that `fleet capture --from-chain` reproduces `events[]` and
 * `votes[].onchainReason` exactly from chain data alone. Gated on `FLEET_INTEGRATION=1` and
 * skipped cleanly without `forge`/`anvil` on `PATH`, matching every other integration test in this
 * repo (see `apps/worker/src/fleet-smoke.integration.test.ts`).
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliMain = path.join(currentDir, "cli.ts");

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const FORGE_AVAILABLE = hasBinary("forge");
const ANVIL_AVAILABLE = hasBinary("anvil");
const RUN_INTEGRATION = process.env.FLEET_INTEGRATION === "1" && FORGE_AVAILABLE && ANVIL_AVAILABLE;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("could not determine a free port"));
      }
    });
  });
}

type AnvilHandle = { child: ChildProcessByStdio<null, Readable, Readable>; rpcUrl: string };

/** Same recipe as `client.integration.test.ts` and the keeper/worker smoke test: `--block-time 1`
 *  so `fleet demo --fresh-anvil`'s own `evm_increaseTime`/`evm_mine` calls are what skip forward
 *  through each fixture's voting window, not wall-clock sleep. */
async function startAnvil(): Promise<AnvilHandle> {
  const port = await findFreePort();
  const child = spawn("anvil", ["--port", String(port), "--block-time", "1"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("anvil did not report ready within 15s")), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`anvil exited early (code ${code}); output:\n${output}`));
    });
  });
  return { child, rpcUrl: `http://127.0.0.1:${port}` };
}

function stopAnvil(handle: AnvilHandle): void {
  handle.child.kill();
}

type CliResult = { code: number | null; output: string };

/** Runs `fleet <args>` as a real child process (`tsx apps/runner/src/cli.ts <args>`, the same way
 *  a user invokes the `fleet` bin), collecting combined stdout/stderr and resolving with the exit
 *  code once the process exits. */
async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliMain, ...args], { stdio: ["ignore", "pipe", "pipe"], env }) as ChildProcessByStdio<
      null,
      Readable,
      Readable
    >;
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

function sortEventsForComparison(events: RunRecordDocument["events"]): RunRecordDocument["events"] {
  return [...events].sort((a, b) => {
    const key = (e: RunRecordDocument["events"][number]) => `${e["proposalId"]}:${e["type"]}:${e["txHash"]}:${e["logIndex"]}`;
    return key(a).localeCompare(key(b));
  });
}

function sortVotesForComparison(votes: RunRecordDocument["votes"]): RunRecordDocument["votes"] {
  return [...votes].sort((a, b) => `${a.proposalId}:${a.voterAddress}`.localeCompare(`${b.proposalId}:${b.voterAddress}`));
}

describe.skipIf(!RUN_INTEGRATION)("fleet demo (end to end, fresh Anvil)", () => {
  let anvil: AnvilHandle;
  let reportDir: string;
  const scenarioStart = Date.now();

  beforeAll(async () => {
    anvil = await startAnvil();
    reportDir = mkdtempSync(path.join(tmpdir(), "fleet-demo-reports-"));
  }, 30_000);

  afterAll(() => {
    if (anvil) stopAnvil(anvil);
    if (reportDir && existsSync(reportDir)) rmSync(reportDir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`fleet demo integration test runtime: ${Date.now() - scenarioStart}ms`);
  });

  it(
    "runs all eight scripted fixtures to exit 0, and fleet capture --from-chain reproduces events[] and votes[].onchainReason",
    async () => {
      const env = { ...process.env, LOG_LEVEL: "warn" };

      const demoResult = await runCli(["demo", "--rpc", anvil.rpcUrl, "--fresh-anvil", "--report-dir", reportDir], env);
      if (demoResult.code !== 0) {
        throw new Error(`fleet demo exited ${demoResult.code}:\n${demoResult.output}`);
      }

      const runDirs = readdirSync(reportDir);
      const demoRunDirs = runDirs.filter((d) => d.startsWith("demo-"));
      expect(demoRunDirs.length).toBe(1);
      const runId = demoRunDirs[0]!;
      const recordPath = path.join(reportDir, runId, "record.json");
      const reportPath = path.join(reportDir, runId, "report.md");
      expect(existsSync(recordPath)).toBe(true);
      expect(existsSync(reportPath)).toBe(true);

      const liveRecord = JSON.parse(readFileSync(recordPath, "utf8")) as RunRecordDocument;
      expect(liveRecord.proposals.length).toBe(8);
      const fixtureNames = liveRecord.proposals.map((p) => p.fixtureName).sort();
      expect(fixtureNames).toEqual(
        ["delegation-visible", "guardian-cancel", "hf-replay", "impostor", "late-vote", "legit-amendment", "three-unavailable", "two-colluding"].sort(),
      );

      const failed = liveRecord.proposals.filter((p) => !p.pass);
      expect(failed, `fixtures that did not match their expected outcome: ${JSON.stringify(failed)}`).toEqual([]);

      const captureResult = await runCli(
        ["capture", "--run-id", runId, "--from-chain", "--rpc", anvil.rpcUrl, "--report-dir", reportDir],
        env,
      );
      if (captureResult.code !== 0) {
        throw new Error(`fleet capture --from-chain exited ${captureResult.code}:\n${captureResult.output}`);
      }

      const recapturedRecord = JSON.parse(readFileSync(recordPath, "utf8")) as RunRecordDocument;

      const liveEvents = sortEventsForComparison(liveRecord.events);
      const recapturedEvents = sortEventsForComparison(recapturedRecord.events);
      expect(recapturedEvents).toEqual(liveEvents);

      const liveVotes = sortVotesForComparison(liveRecord.votes).map((v) => ({ proposalId: v.proposalId, voterAddress: v.voterAddress, onchainReason: v.onchainReason }));
      const recapturedVotes = sortVotesForComparison(recapturedRecord.votes).map((v) => ({
        proposalId: v.proposalId,
        voterAddress: v.voterAddress,
        onchainReason: v.onchainReason,
      }));
      expect(recapturedVotes).toEqual(liveVotes);
    },
    600_000,
  );
});

describe.skipIf(RUN_INTEGRATION)("fleet demo integration test (skipped)", () => {
  it("skips cleanly without FLEET_INTEGRATION=1 or a missing forge/anvil binary", () => {
    expect(RUN_INTEGRATION).toBe(false);
  });
});
