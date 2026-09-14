import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import type { Address } from "viem";
import { agoraGovernorAbi, taskLedgerAbi } from "@fleet/abi";
import { ExperimentConfigV1 } from "@fleet/schemas";
import { anvilDevKey, DEMO_ACCOUNT_INDEX } from "./anvil-keys.js";
import { experimentConfigHash, manifestPathsForRun, runExperiment } from "./pipeline/run-pipeline.js";
import type { RunRecordDocument } from "./pipeline/record.js";
import { JsonFileRunStore } from "./pipeline/state.js";
import type { RunRecord } from "./pipeline/state.js";

/**
 * `fleet run` end to end on a fresh Anvil, and then resumed (final review I1).
 *
 * The first pass drives `experiments/examples/local-hf-replay.experiment.json` through all ten
 * spec 12.2 stages: PREFLIGHT, CHAIN_READY, DEPLOYED (the real forge script), VERIFIED,
 * INDEXERS_READY, TASK_OPENED, AGENTS_RUNNING (the `hf-replay` fixture: one proposal, five
 * scripted votes, Defeated), TASK_ENDED, CAPTURED, REPORTED.
 *
 * The next four passes are crashes. Rewinding the run store's checkpoint to `TASK_OPENED` is what a
 * process that died inside `AGENTS_RUNNING` leaves behind; rewinding it to `INDEXERS_READY` with a
 * task id already in the payload is what a process that died at the `TASK_OPENED` boundary leaves
 * behind; `TASK_ENDED` is a process that died between `AGENTS_RUNNING` and `CAPTURED`; `CAPTURED`
 * is one that died before it rendered the report. Before the fix waves the first of those threw
 * "AGENTS_RUNNING: missing prior stage output", the second opened a brand new task, and the last
 * two threw "CAPTURED/REPORTED: missing prior stage output". All four must now finish without
 * opening a second task or submitting a second proposal, which is what the assertions check
 * against the chain itself.
 *
 * Uses the well-known Anvil dev accounts (`anvil-keys.ts`, derived from the standard
 * `test test test ... junk` mnemonic) for every role. Gated on `FLEET_INTEGRATION=1` and skipped
 * cleanly without `forge`/`anvil`/`cast`, like every other integration test here.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");
const experimentPath = path.join(repoRoot, "experiments", "examples", "local-hf-replay.experiment.json");

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const RUN_INTEGRATION =
  process.env.FLEET_INTEGRATION === "1" && hasBinary("forge") && hasBinary("anvil") && hasBinary("cast");

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

/** `--block-time 1` so the chain clock advances on its own: `fleet run` never moves time by RPC
 *  (unlike `fleet demo --fresh-anvil`), so the fixture's waits are real wall-clock polls against
 *  the experiment's own votingDelay and votingPeriod. */
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

function runEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOG_LEVEL: "warn",
    FLEET_DEPLOYER_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.deployer),
    FLEET_OPERATOR_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.operator),
    FLEET_GUARDIAN_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.guardian),
    FLEET_KEEPER_KEY: anvilDevKey(DEMO_ACCOUNT_INDEX.keeper),
    FLEET_AGENT_KEY_0: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(0)),
    FLEET_AGENT_KEY_1: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(1)),
    FLEET_AGENT_KEY_2: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(2)),
    FLEET_AGENT_KEY_3: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(3)),
    FLEET_AGENT_KEY_4: anvilDevKey(DEMO_ACCOUNT_INDEX.agent(4)),
  };
}

describe.skipIf(!RUN_INTEGRATION)("fleet run (end to end, then resumed, on a fresh Anvil)", () => {
  let anvil: AnvilHandle;
  let workDir: string;
  /** `forge`'s own fs_permissions (contracts/foundry.toml) only let DeployFleet.s.sol and
   *  VerifyDeployment.s.sol read under `contracts/` and `../deployments`, so this run's
   *  `deploymentsDir` has to sit inside the repo's `deployments/`. It is a throwaway directory of
   *  its own, never `deployments/31337/`, so the committed local manifest is left alone; `afterAll`
   *  removes it. */
  let deploymentsDir: string;
  const scenarioStart = Date.now();

  beforeAll(async () => {
    anvil = await startAnvil();
    workDir = mkdtempSync(path.join(tmpdir(), "fleet-run-pipeline-"));
    deploymentsDir = mkdtempSync(path.join(repoRoot, "deployments", ".fleet-it-"));
  }, 30_000);

  afterAll(() => {
    if (anvil) anvil.child.kill();
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    if (deploymentsDir && existsSync(deploymentsDir)) rmSync(deploymentsDir, { recursive: true, force: true });
    // eslint-disable-next-line no-console
    console.log(`fleet run integration test runtime: ${Date.now() - scenarioStart}ms`);
  });

  it(
    "runs every stage, then resumes from four checkpoints without opening a second task or submitting a second proposal",
    async () => {
      const reportDir = path.join(workDir, "reports");
      const infraDir = path.join(workDir, "infra");
      // `forge`'s own fs_permissions (contracts/foundry.toml) only allow reads under `contracts/`
      // and `../deployments`, so the deploy config the DEPLOYED stage hands to
      // DeployFleet.s.sol has to be the committed one, read in place. Everything this test writes
      // (manifests, reports, read-side config, run state) still goes to its own temp directory.
      const configDir = path.join(repoRoot, "deployments", "configs");
      const runDir = path.join(reportDir, "run-1");
      mkdirSync(runDir, { recursive: true });

      // The committed example config, with only its RPC redirected at this test's own Anvil (the
      // file itself names the conventional 127.0.0.1:8545, and this test picks a free port).
      const committed = ExperimentConfigV1.parse(JSON.parse(readFileSync(experimentPath, "utf8")));
      const experiment = {
        ...committed,
        target: { ...committed.target, rpcHttp: anvil.rpcUrl, rpcWs: anvil.rpcUrl.replace("http://", "ws://") },
      };
      const localExperimentPath = path.join(workDir, "local-hf-replay.experiment.json");
      writeFileSync(localExperimentPath, `${JSON.stringify(experiment, null, 2)}\n`, "utf8");

      // DEPLOYED reads `<configDir>/<experiment name>.deploy.json`, the fleet.deploy.v1 config
      // named after the experiment.
      expect(existsSync(path.join(configDir, `${experiment.name}.deploy.json`))).toBe(true);

      const store = new JsonFileRunStore(runDir);
      const options = {
        runId: "run-1",
        experimentPath: localExperimentPath,
        fixturesDir: path.join(repoRoot, "experiments", "fixtures"),
        repoRoot,
        contractsDir: path.join(repoRoot, "contracts"),
        configDir,
        infraDir,
        abiSourceDir: path.join(repoRoot, "packages", "abi", "abis"),
        deploymentsDir,
        reportDir,
        store,
      };
      const env = runEnv();

      // ---- pass 1: the whole pipeline ----
      const first = await runExperiment(options, env);
      expect(first.taskId).not.toBeNull();
      expect(first.result?.pass, JSON.stringify(first.result?.mismatches ?? [])).toBe(true);
      expect(first.result?.finalStateName).toBe("Defeated");

      const manifestPaths = manifestPathsForRun(deploymentsDir, 31337, "run-1");
      expect(existsSync(manifestPaths.latest)).toBe(true);
      expect(existsSync(manifestPaths.perRun)).toBe(true);
      expect(readFileSync(manifestPaths.latest, "utf8")).toBe(readFileSync(manifestPaths.perRun, "utf8"));

      const recordPath = path.join(runDir, "record.json");
      expect(existsSync(recordPath)).toBe(true);
      expect(existsSync(path.join(runDir, "report.md"))).toBe(true);
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as RunRecordDocument;
      expect(record.proposals.length).toBe(1);
      expect(record.proposals[0]?.fixtureName).toBe("hf-replay");
      // Final review I3: the hash covers the config the record actually stores.
      expect(record.configHash).toBe(experimentConfigHash(record.config));

      const ledger = record.manifest.addresses.ledger as Address;
      const governor = record.manifest.addresses.governor as Address;
      const publicClient = createPublicClient({ transport: http(anvil.rpcUrl) });
      const taskCountAfterFirst = await publicClient.readContract({
        address: ledger,
        abi: taskLedgerAbi,
        functionName: "taskCount",
      });
      const proposalsAfterFirst = await publicClient.getContractEvents({
        address: governor,
        abi: agoraGovernorAbi,
        eventName: "ProposalCreated",
        fromBlock: 0n,
        toBlock: "latest",
      });
      expect(taskCountAfterFirst).toBe(1n);
      expect(proposalsAfterFirst.length).toBe(1);

      const finished = (await store.get("run-1")) as RunRecord;
      expect(finished.stage).toBe("REPORTED");

      // ---- pass 2: a crash inside AGENTS_RUNNING (checkpoint at TASK_OPENED) ----
      await store.save({ ...finished, stage: "TASK_OPENED", updatedAt: new Date().toISOString() });
      const resumedInAgents = await runExperiment(options, env);
      expect(resumedInAgents.taskId).toBe(first.taskId);
      expect(resumedInAgents.result?.proposalId).toBe(first.result?.proposalId);
      expect(resumedInAgents.result?.finalStateName).toBe("Defeated");

      // ---- pass 3: a crash at the TASK_OPENED boundary (checkpoint at INDEXERS_READY, task id
      // already in the payload), so TASK_OPENED itself re-runs and must not open another task ----
      await store.save({ ...finished, stage: "INDEXERS_READY", updatedAt: new Date().toISOString() });
      const resumedInTaskOpened = await runExperiment(options, env);
      expect(resumedInTaskOpened.taskId).toBe(first.taskId);
      expect(resumedInTaskOpened.result?.proposalId).toBe(first.result?.proposalId);

      // ---- pass 4: a crash between AGENTS_RUNNING and CAPTURED (checkpoint at TASK_ENDED) ----
      // Fix-wave finding 1: this used to throw "CAPTURED: missing prior stage output", because a
      // run result is not something a JSON checkpoint can carry. CAPTURED now re-enters
      // AGENTS_RUNNING, which is idempotent, rather than giving up on the run.
      rmSync(recordPath, { force: true });
      await store.save({ ...finished, stage: "TASK_ENDED", updatedAt: new Date().toISOString() });
      const resumedAtCaptured = await runExperiment(options, env);
      expect(resumedAtCaptured.result?.proposalId).toBe(first.result?.proposalId);
      expect(existsSync(recordPath)).toBe(true);
      const recapturedRecord = JSON.parse(readFileSync(recordPath, "utf8")) as RunRecordDocument;
      expect(recapturedRecord.proposals.length).toBe(1);
      expect(recapturedRecord.taskId).toBe(first.taskId?.toString());

      // ---- pass 5: a crash between CAPTURED and REPORTED (checkpoint at CAPTURED) ----
      // The record is on disk, so `rehydrateRunCtx` reads it back and REPORTED renders from it
      // without re-running anything.
      const reportPath = path.join(runDir, "report.md");
      rmSync(reportPath, { force: true });
      await store.save({
        ...finished,
        stage: "CAPTURED",
        updatedAt: new Date().toISOString(),
        payload: { ...finished.payload, recordPath },
      });
      const resumedAtReported = await runExperiment(options, env);
      expect(resumedAtReported.reportPath).toBe(reportPath);
      expect(existsSync(reportPath)).toBe(true);
      expect(readFileSync(reportPath, "utf8")).toContain("hf-replay");

      const taskCountAfterResumes = await publicClient.readContract({
        address: ledger,
        abi: taskLedgerAbi,
        functionName: "taskCount",
      });
      const proposalsAfterResumes = await publicClient.getContractEvents({
        address: governor,
        abi: agoraGovernorAbi,
        eventName: "ProposalCreated",
        fromBlock: 0n,
        toBlock: "latest",
      });
      expect(taskCountAfterResumes, "a resumed run opened a second task").toBe(taskCountAfterFirst);
      expect(proposalsAfterResumes.length, "a resumed run submitted a second proposal").toBe(proposalsAfterFirst.length);
    },
    900_000,
  );
});

describe.skipIf(RUN_INTEGRATION)("fleet run integration test (skipped)", () => {
  it("skips cleanly without FLEET_INTEGRATION=1 or a missing forge/anvil/cast binary", () => {
    expect(RUN_INTEGRATION).toBe(false);
  });
});
