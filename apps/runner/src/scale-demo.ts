import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FixtureV1, MAX_FLEET_MEMBERS, canonicalize } from "@fleet/schemas";
import { FleetClient, addressesFromManifest, mapConcurrent } from "@fleet/sdk";
import { LedgerWatcher } from "@fleet/gateway";
import { ToolRouter, Workspace } from "@fleet/agent-runtime";
import { anvilDevKey, DEMO_ACCOUNT_INDEX } from "./anvil-keys.js";
import { deployFleet, verifyDeployment } from "./deploy.js";
import { DEMO_TASK_CHARTER } from "./demo.js";
import { runFixture } from "./pipeline/fixture-runner.js";
import type { FleetKeys, FixtureRunResult } from "./pipeline/fixture-runner.js";
import { openTask } from "./pipeline/task.js";
import { buildRecord, captureFromChain, writeJsonRecord } from "./pipeline/record.js";
import { renderReport } from "./pipeline/report.js";
import { withHostOverrides } from "./pipeline/host-overrides.js";
import { executionFixture, probeExecution } from "./execution-demo.js";

function canonicalRecord(value: unknown): string {
  // Same representation as record.json: chain-scale integers are decimal strings.
  return canonicalize(JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item)));
}

function canonicalRows(rows: readonly unknown[]): string {
  // Concurrent jobs retain agent order locally; chain logs retain transaction order.
  return canonicalize(rows.map(canonicalRecord).sort());
}

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  return port;
}

export function scaleFixtures(repoRoot: string, memberCount: number): FixtureV1[] {
  if (!Number.isSafeInteger(memberCount) || memberCount < 2 || memberCount > MAX_FLEET_MEMBERS) {
    throw new Error(`members must be between 2 and ${MAX_FLEET_MEMBERS}`);
  }
  return ["hf-replay", "legit-amendment"].map((name, scenario) => {
    const fixture = FixtureV1.parse(JSON.parse(readFileSync(path.join(repoRoot, "experiments/fixtures/scripted", `${name}.json`), "utf8")));
    const yesCount = scenario === 0 ? Math.floor(memberCount * 0.2) : Math.ceil(memberCount * 0.6);
    return FixtureV1.parse({
      ...fixture,
      name: `scale-${name}`,
      description: `${fixture.description}. Scripted load test with ${memberCount} identities; ballots are prescribed, no model inference.`,
      script: Object.fromEntries(Array.from({ length: memberCount }, (_, id) => [String(id), id < yesCount ? "FOR" : "AGAINST"])),
      expected: { ...fixture.expected, missingVotes: 0 },
    });
  });
}

/** Owns a separate local chain, never an existing RPC or live keys. Exercises the same workers,
 *  signers, governor, ledger, gateway and report path as other scripted experiments. */
export async function runScaleDemo(opts: { repoRoot: string; reportDir: string; members: number; concurrency: number; execution?: boolean; log?: (text: string) => void }) {
  const fixtures = scaleFixtures(opts.repoRoot, opts.members);
  if (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 64) throw new Error("concurrency must be between 1 and 64");
  const started = Date.now();
  const runId = `${opts.execution ? "execution" : "scale"}-${opts.members}-${started}`;
  const log = opts.log ?? (() => {});
  const runDir = path.resolve(opts.reportDir, runId);
  const deployDir = path.join(opts.repoRoot, "deployments", ".fleet-it-" + runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(deployDir, { recursive: true });
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const gasLimit = 16_777_216n;
  // Interval mining drains Forge's broadcast batches when several transactions fill a block.
  const child = spawn("anvil", ["--host", "127.0.0.1", "--port", String(port), "--silent", "--gas-limit", String(gasLimit), "--block-time", "1", "--mixed-mining"], { stdio: "ignore" });
  let startupError: Error | null = null;
  child.on("error", err => { startupError = err; });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const rpc = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 2000 }) });
  const rpcCall = (method: string, params: unknown[]) => rpc.request({ method: method as never, params: params as never });
  const advance = async (seconds: number) => { await rpcCall("evm_increaseTime", [seconds]); await rpcCall("evm_mine", []); };
  const dumpChain = async () => {
    const state = await rpcCall("anvil_dumpState", []);
    writeJsonRecord(path.join(runDir, "chain-state.json"), state);
  };
  let ready = false;
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Anvil exited during startup: ${child.exitCode}`);
      try { if (await rpc.getChainId() === 31337) { ready = true; break; } } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("owned Anvil did not become ready");
    log(`scale: ${opts.members} scripted members, ${opts.concurrency} concurrent vote jobs, owned Anvil ${rpcUrl}`);
    const keys: FleetKeys = {
      deployerKey: anvilDevKey(DEMO_ACCOUNT_INDEX.deployer), operatorKey: anvilDevKey(DEMO_ACCOUNT_INDEX.operator),
      guardianKey: anvilDevKey(DEMO_ACCOUNT_INDEX.guardian), keeperKey: anvilDevKey(DEMO_ACCOUNT_INDEX.keeper),
      agentKeys: Object.fromEntries(Array.from({ length: opts.members }, (_, id) => [id, anvilDevKey(DEMO_ACCOUNT_INDEX.agent(id))])),
    };
    const members = Array.from({ length: opts.members }, (_, id) => privateKeyToAccount(keys.agentKeys[id]!).address);
    await mapConcurrent(members, 32, async account => rpcCall("anvil_setBalance", [account, toHex(10n ** 20n)]));
    const deployConfig = {
      schema: "fleet.deploy.v1", tokenName: "Fleet Vote", tokenSymbol: "FLEET", members,
      agentManifests: members.map((_, id) => JSON.stringify({ role: ["planner", "engineer", "critic", "budget-reviewer", "safety-reviewer"][id % 5], provider: "scripted", model: "scripted-v1", promptVersion: "1", operator: "local-scale" })),
      fleetManifest: JSON.stringify({ experiment: runId, constitution: "fleet.constitution.v1", harness: "scripted-scale" }),
      operator: privateKeyToAccount(keys.operatorKey).address, guardian: privateKeyToAccount(keys.guardianKey).address,
      votingDelay: 5, votingPeriod: 3600, timelockDelay: 5, proposalThreshold: "1000000000000000000", quorumNumerator: 6000, maxTaskLifetime: 7200,
    };
    const configPath = path.join(deployDir, "deploy.json");
    writeJsonRecord(configPath, deployConfig);
    writeJsonRecord(path.join(runDir, "deploy.json"), deployConfig);
    const manifestPath = path.join(deployDir, "manifest.json");
    const contractsDir = path.join(opts.repoRoot, "contracts");
    const { manifest } = await deployFleet({ contractsDir, configPath, rpcUrl, deployerKey: keys.deployerKey, outPath: manifestPath, expectedChainId: 31337, sequentialBroadcast: true });
    writeJsonRecord(path.join(runDir, "manifest.json"), manifest);
    await advance(2);
    await verifyDeployment({ contractsDir, manifestPath, rpcUrl });
    log(`scale: deployment verified for ${members.length} members`);
    const deploymentEnd = await rpc.getBlockNumber({ cacheTime: 0 });
    const blocks = Array.from({ length: Number(deploymentEnd) }, (_, index) => BigInt(index + 1));
    const deploymentTransactions = (await mapConcurrent(blocks, 16, async blockNumber => {
      const block = await rpc.getBlock({ blockNumber });
      return Promise.all(block.transactions.map(async hash => {
        const receipt = await rpc.getTransactionReceipt({ hash });
        if (receipt.status !== "success" || receipt.gasUsed > gasLimit) throw new Error("deployment transaction failed or exceeded the gas cap");
        return { txHash: hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), feeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
      }));
    })).flat();
    writeJsonRecord(path.join(runDir, "deployment-transactions.json"), deploymentTransactions);
    const addresses = addressesFromManifest(manifest);
    const client = new FleetClient({ rpcUrl, chainId: 31337, addresses });
    const results: FixtureRunResult[] = [];
    const executorChecks: unknown[] = [];
    for (const [scenario, baseFixture] of fixtures.entries()) {
      const { taskId } = await openTask({ client, addresses, chainId: 31337, rpcUrl, operatorKey: keys.operatorKey, charter: DEMO_TASK_CHARTER, lifetimeSeconds: 7200 });
      const fixture = opts.execution ? await executionFixture(client, taskId, baseFixture, scenario) : baseFixture;
      const result = await runFixture({ client, addresses, chainId: 31337, rpcUrl, keys, advanceTime: advance, submissionMarginSec: 6, voteConcurrency: opts.concurrency, log }, fixture, taskId);
      results.push(result);
      writeJsonRecord(path.join(runDir, "fixtures", `${fixture.name}.json`), result);
      // Require every onchain voter and reason, not merely a quorum outcome.
      const chainVotes = result.trace.events.filter(event => event.type === "VoteCast");
      const voterSet = new Set(chainVotes.map(v => v.voter.toLowerCase()));
      const memberIds = new Map(members.map((member, id) => [member.toLowerCase(), id]));
      const correctBallots = chainVotes.every(v => {
        const id = memberIds.get(v.voter.toLowerCase());
        return id !== undefined && v.weight === 10n ** 18n && v.reason.length > 0 && v.support === (fixture.script[String(id)] === "FOR" ? 1 : 0);
      });
      if (!result.pass || chainVotes.length !== members.length || !members.every(m => voterSet.has(m.toLowerCase())) || !correctBallots || !result.votes.every(v => v.jobState === "voted")) {
        writeJsonRecord(path.join(runDir, "failed-fixture.json"), result);
        throw new Error(`scale fixture failed: ${fixture.name}, ${chainVotes.length}/${members.length} votes`);
      }
      if (opts.execution) {
        const check = await probeExecution(client, rpcUrl, keys, fixture);
        result.fees.push(...check.fees);
        executorChecks.push(check);
        writeJsonRecord(path.join(runDir, "executor-checks.json"), executorChecks);
        writeJsonRecord(path.join(runDir, "fixtures", `${fixture.name}.json`), result);
        continue;
      }
      let requests = 0;
      const host = fixture.trigger.action?.target ?? "pypi.org";
      const server = createServer((_req, res) => { requests++; res.end("local fixture response"); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
        const workspace = await Workspace.fromFixture(path.join(opts.repoRoot, "experiments/fixtures/repos/tiny-lib"), 0, path.join(runDir, `probe-${taskId}`));
        const router = new ToolRouter({ workspace, watcher: new LedgerWatcher(client, taskId), agentId: 0, budget: { toolCalls: 0 }, log: () => {}, fetchImpl: withHostOverrides(fetch, { [host]: origin }) });
        const outcome = await router.call({ class: "network_fetch", target: host, args: fixture.trigger.action?.args as Record<string, unknown> ?? {} });
        const approved = fixture.expected.outcome === "Executed";
        if (outcome.ok !== approved || requests !== Number(approved)) throw new Error("executor outcome disagrees with governance");
        if (!approved && (outcome.ok || !("blocked" in outcome) || outcome.blocked.reason !== "target_not_allowlisted")) throw new Error("rejected action was not blocked by its charter permission");
        executorChecks.push({ taskId: taskId.toString(), host, proposalId: result.proposalId.toString(), outcome, requests });
      } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
      writeJsonRecord(path.join(runDir, "executor-checks.json"), executorChecks);
    }
    const config = { schema: "fleet.scale.v1", mode: "scripted", execution: opts.execution ?? false, members: opts.members, concurrency: opts.concurrency, rpcUrl, blockGasLimit: gasLimit.toString() };
    const record = await buildRecord({ client, runId, config, configHash: keccak256(toHex(canonicalize(config))), manifest, results, timings: { startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), runtimeMs: Date.now() - started }, versions: { node: process.version }, runDir });
    writeJsonRecord(path.join(runDir, "record.json"), record);
    // Reconstruct while this owned chain is still live, and compare the observable record.
    const captured = await captureFromChain(client, record);
    writeJsonRecord(path.join(runDir, "chain-recaptured.json"), captured);
    if (canonicalRows(captured.events) !== canonicalRows(record.events) || canonicalRows(captured.votes) !== canonicalRows(record.votes) || canonicalRows(captured.fees) !== canonicalRows(record.fees)) throw new Error("chain recapture differs from the live record");
    if (canonicalRows(captured.execution?.events ?? []) !== canonicalRows(record.execution?.events ?? [])
      || canonicalRows(captured.execution?.artifacts ?? []) !== canonicalRows(record.execution?.artifacts ?? [])) throw new Error("contract execution recapture differs from the live record");
    writeFileSync(path.join(runDir, "report.md"), renderReport(record, { title: `Scripted ${opts.execution ? "contract execution" : "scale"} experiment: ${opts.members} members`, reproducibility: { checked: true, matched: true } }));
    const maxDeploymentGas = deploymentTransactions.reduce((max, tx) => BigInt(tx.gasUsed) > max ? BigInt(tx.gasUsed) : max, 0n);
    const summary = { runId, mode: "scripted", memberCount: members.length, proposalCount: results.length, voteCount: record.votes.length, deploymentTransactionCount: deploymentTransactions.length, maxDeploymentGas: maxDeploymentGas.toString(), deploymentGas: deploymentTransactions.reduce((sum, tx) => sum + BigInt(tx.gasUsed), 0n).toString(), outcomeDistribution: record.metrics.outcomeDistribution, allPassed: true, chainRecaptureMatches: true, runtimeMs: Date.now() - started };
    writeJsonRecord(path.join(runDir, "scale-summary.json"), summary);
    await dumpChain();
    log(`scale: verified ${record.votes.length} ballots; maximum deployment gas ${maxDeploymentGas}; evidence ${runDir}`);
    return { runDir, summary };
  } catch (error) {
    writeJsonRecord(path.join(runDir, "error.json"), { error: error instanceof Error ? error.message : String(error), runtimeMs: Date.now() - started });
    if (ready) await dumpChain().catch(() => {});
    throw error;
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
  }
}
