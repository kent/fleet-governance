import { execFileSync, spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWalletClient, defineChain, http, keccak256, publicActions, toHex } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ManifestV1 } from "@fleet/schemas";
import { agoraGovernorAbi, taskLedgerAbi } from "@fleet/abi";
import {
  FleetClient,
  ProposalState,
  addressesFromManifest,
  buildDecisionDescription,
  encodeRecordDecision,
  payloadHashForAction,
} from "@fleet/sdk";
import type { DecisionV1 } from "@fleet/schemas";

/**
 * Cross-app smoke test for `@fleet/keeper` and `@fleet/worker` (task 7): deploys a real fleet on
 * a local Anvil, opens a task and proposes a decision with raw viem wallets exactly as
 * `packages/sdk/src/client.integration.test.ts` does, then spawns both apps as real child
 * processes (the way the Runner, task 8, will run them) and asserts the proposal reaches
 * `Executed` end to end: three `@fleet/worker` processes (agents 1, 2, 3, `scripted:FOR`) vote,
 * and one `@fleet/keeper` process queues and executes once the voting and timelock windows have
 * passed. Gated on `FLEET_INTEGRATION=1` and skipped cleanly without `forge`/`anvil` on `PATH`.
 */

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../..");
const contractsDir = path.join(repoRoot, "contracts");
const manifestOutPath = path.join(contractsDir, ".fleet-manifest-tmp.json");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const workerMain = path.join(repoRoot, "apps", "worker", "src", "main.ts");
const keeperMain = path.join(repoRoot, "apps", "keeper", "src", "main.ts");

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

type AnvilAccount = { index: number; address: Address; key: Hex };

/** Same parser as `client.integration.test.ts`: reads Anvil's own startup banner for its
 *  deterministic dev accounts and private keys rather than hardcoding them. */
function parseAnvilAccounts(output: string): AnvilAccount[] {
  const accountsSection = output.split("Available Accounts")[1]?.split("Private Keys")[0] ?? "";
  const keysSection = output.split("Private Keys")[1]?.split(/Wallet|Base Fee|Gas/)[0] ?? "";
  const addrs = new Map<number, Address>(
    [...accountsSection.matchAll(/\((\d+)\)\s+(0x[0-9a-fA-F]{40})\b/g)].map((m) => [Number(m[1]), m[2] as Address]),
  );
  const keys = new Map<number, Hex>(
    [...keysSection.matchAll(/\((\d+)\)\s+(0x[0-9a-fA-F]{64})\b/g)].map((m) => [Number(m[1]), m[2] as Hex]),
  );
  const accounts: AnvilAccount[] = [];
  for (const [index, address] of addrs) {
    const key = keys.get(index);
    if (key) accounts.push({ index, address, key });
  }
  accounts.sort((a, b) => a.index - b.index);
  return accounts;
}

type AnvilHandle = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  rpcUrl: string;
  accounts: AnvilAccount[];
};

/** Same recipe as `client.integration.test.ts`: `--block-time 1` (real interval mining), so
 *  `evm_increaseTime` + `evm_mine` are what skip waits, not wall-clock sleep. */
async function startAnvil(): Promise<AnvilHandle> {
  const port = await findFreePort();
  const child = spawn("anvil", ["--port", String(port), "--block-time", "1"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  return { child, rpcUrl: `http://127.0.0.1:${port}`, accounts: parseAnvilAccounts(output) };
}

function stopAnvil(handle: AnvilHandle): void {
  handle.child.kill();
}

/** Same recipe as `client.integration.test.ts`: runs the Part 1 deploy script against a running
 *  Anvil, per contracts/README.md's "Deploying locally". */
function deployWithForge(rpcUrl: string, deployerKey: Hex): void {
  execFileSync("forge", ["script", "script/DeployFleet.s.sol", "--rpc-url", rpcUrl, "--broadcast"], {
    cwd: contractsDir,
    env: {
      ...process.env,
      FLEET_DEPLOY_CONFIG: "../deployments/configs/local-5.json",
      FLEET_DEPLOYER_KEY: deployerKey,
      FLEET_MANIFEST_OUT: ".fleet-manifest-tmp.json",
    },
    stdio: "pipe",
  });
}

function walletFor(rpcUrl: string, chainId: number, key: Hex) {
  const chain = defineChain({
    id: chainId,
    name: `fleet-governance-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(rpcUrl) }).extend(
    publicActions,
  );
}

/** `evm_increaseTime`/`evm_mine` are Anvil test methods, not part of viem's standard public RPC
 *  schema; same escape hatch as `client.integration.test.ts`. */
async function mineForward(client: FleetClient, seconds: number): Promise<void> {
  await client.publicClient.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await client.publicClient.request({ method: "evm_mine" as never, params: [] as never });
}

async function waitForState(client: FleetClient, proposalId: bigint, target: ProposalState): Promise<ProposalState> {
  for (let i = 0; i < 200; i++) {
    const state = await client.getProposalState(proposalId);
    if (state === target) return state;
    await mineForward(client, 10);
  }
  return client.getProposalState(proposalId);
}

/** Polls `check` every `intervalMs` (real wall-clock time; this never calls `mineForward`, so
 *  the caller controls whether chain time also advances) until it resolves true, or throws once
 *  `timeoutMs` has elapsed. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, description: string): Promise<void> {
  const start = Date.now();
  const intervalMs = 250;
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type ChildHandle = { name: string; child: ChildProcessByStdio<null, Readable, Readable>; logs: string[] };

function spawnApp(name: string, mainPath: string, env: NodeJS.ProcessEnv): ChildHandle {
  const child = spawn(tsxBin, [mainPath], { stdio: ["ignore", "pipe", "pipe"], env }) as ChildProcessByStdio<
    null,
    Readable,
    Readable
  >;
  const logs: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  return { name, child, logs };
}

/** Sends SIGTERM (the app's own graceful-shutdown path: finish the poll in flight, then exit 0)
 *  and waits up to 5s for exit before escalating to SIGKILL. */
async function stopChild(handle: ChildHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    handle.child.once("exit", () => resolve());
  });
  handle.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill("SIGKILL");
  }
}

function dumpLogs(handles: ChildHandle[]): string {
  return handles.map((h) => `--- ${h.name} ---\n${h.logs.join("")}`).join("\n");
}

describe.skipIf(!RUN_INTEGRATION)("keeper and worker apps against a live Anvil deployment", () => {
  let anvil: AnvilHandle;
  let client: FleetClient;
  let manifestPath: string;
  let proposalId: bigint;
  let taskId: bigint;
  const children: ChildHandle[] = [];
  const scenarioStart = Date.now();

  beforeAll(async () => {
    anvil = await startAnvil();
    const deployer = anvil.accounts.find((a) => a.index === 0);
    const operatorAccount = anvil.accounts.find((a) => a.index === 6);
    // agentId N registers to anvil account index N+1 (deploy config local-5.json's `members`
    // list, in order); agent 0 proposes, agents 1-3 vote, agent 4 and the keeper account are
    // unused so this scenario stays close to the sdk's own 3-For integration scenario.
    const agentAccounts = [1, 2, 3, 4].map((i) => anvil.accounts.find((a) => a.index === i));
    const keeperAccount = anvil.accounts.find((a) => a.index === 9);
    if (!deployer || !operatorAccount || !keeperAccount || agentAccounts.some((a) => !a)) {
      throw new Error("Anvil did not report the expected dev accounts 0 through 9");
    }

    deployWithForge(anvil.rpcUrl, deployer.key);
    manifestPath = manifestOutPath;
    const manifest = ManifestV1.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    const addresses = addressesFromManifest(manifest);
    client = new FleetClient({ rpcUrl: anvil.rpcUrl, chainId: manifest.chainId, addresses });

    const operator = walletFor(anvil.rpcUrl, manifest.chainId, operatorAccount.key);
    const proposer = walletFor(anvil.rpcUrl, manifest.chainId, (agentAccounts[0] as AnvilAccount).key);

    const charterText = JSON.stringify({
      schema: "fleet.charter.v1",
      goal: "Keeper/worker smoke test task",
      allowedActionClasses: ["read_repo"],
      forbiddenActions: [],
      externalAllowlist: [],
      budget: { toolCalls: 10, inferenceTokens: 1000 },
      stopConditions: ["tests_pass"],
    });
    const openHash = await operator.writeContract({
      address: addresses.ledger,
      abi: taskLedgerAbi,
      functionName: "openTask",
      args: [charterText, 3600n],
    });
    await operator.waitForTransactionReceipt({ hash: openHash });
    taskId = 1n;

    const action = { class: "read_repo" as const, target: "repo", argsHash: `0x${"22".repeat(32)}` as Hex };
    const payloadHash = payloadHashForAction(action);
    const decisionSummary = "Keeper/worker smoke test decision.";
    const calldata = encodeRecordDecision({
      taskId,
      kind: "GRANT_EXCEPTION",
      expectedVersion: 1,
      payloadHash,
      newCharterText: "",
      summary: decisionSummary,
    });
    const decision: DecisionV1 = {
      schema: "fleet.decision.v1",
      taskId: taskId.toString(),
      kind: "GRANT_EXCEPTION",
      expectedVersion: 1,
      payloadHash,
      proposerAgentId: 0,
      action,
      summary: decisionSummary,
      rationale: "The keeper/worker smoke test needs one recorded decision to exercise the whole lifecycle.",
      assumptions: [],
      riskFlags: [],
    };
    const description = buildDecisionDescription(decision, "Planner");

    const proposeHash = await proposer.writeContract({
      address: addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "propose",
      args: [[addresses.ledger], [0n], [calldata], description],
    });
    await proposer.waitForTransactionReceipt({ hash: proposeHash });
    const descriptionHash = keccak256(toHex(description));
    proposalId = await client.publicClient.readContract({
      address: addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "hashProposal",
      args: [[addresses.ledger], [0n], [calldata], descriptionHash],
    });

    await waitForState(client, proposalId, ProposalState.Active);

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      FLEET_MANIFEST: manifestPath,
      FLEET_RPC_HTTP: anvil.rpcUrl,
      FLEET_POLL_MS: "300",
      LOG_LEVEL: "info",
    };

    for (const agentId of [1, 2, 3]) {
      // `agentAccounts` is indexed by anvil account index minus one, and agent N is anvil account
      // index N+1, so agent N's key is `agentAccounts[N]`. This used to be `agentAccounts[agentId
      // - 1]`, which handed worker "agent 1" the key the registry holds for agent 0: exactly the
      // swap final review I4 is about. Nothing failed before, because the worker trusted
      // FLEET_AGENT_ID over the registry; now it refuses, so the mapping has to be right.
      const account = agentAccounts[agentId] as AnvilAccount;
      children.push(
        spawnApp(`worker-${agentId}`, workerMain, {
          ...baseEnv,
          FLEET_AGENT_ID: String(agentId),
          FLEET_AGENT_KEY: account.key,
          FLEET_POLICY: "scripted:FOR",
        }),
      );
    }
    children.push(
      spawnApp("keeper", keeperMain, {
        ...baseEnv,
        FLEET_KEEPER_KEY: keeperAccount.key,
      }),
    );

    for (const handle of children) {
      handle.child.on("exit", (code, signal) => {
        if (code !== null && code !== 0) {
          // eslint-disable-next-line no-console
          console.error(`${handle.name} exited early with code ${code} (signal ${signal})\n${handle.logs.join("")}`);
        }
      });
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all(children.map((h) => stopChild(h)));
    if (anvil) stopAnvil(anvil);
    if (manifestPath && existsSync(manifestPath)) rmSync(manifestPath, { force: true });
    // eslint-disable-next-line no-console
    console.log(`keeper/worker smoke test runtime: ${Date.now() - scenarioStart}ms`);
  });

  it(
    "three scripted:FOR workers vote and the keeper carries the proposal to Executed",
    async () => {
      try {
        // Three real worker processes discover the Active proposal and vote FOR on their own
        // poll loop (real wall-clock; chain time is not advanced here, since the voting window
        // must still look Active to them while they vote).
        await waitUntil(
          async () => {
            const votes = await client.listVotes(proposalId);
            return votes.filter((v) => v.support === 1).length >= 3;
          },
          30_000,
          "3 FOR votes from the spawned worker processes",
        );

        // Past this point every worker's job for this proposal is terminal (voted); skip past
        // the rest of the voting window with test-driven time jumps.
        await waitForState(client, proposalId, ProposalState.Succeeded);

        // The keeper process discovers Succeeded on its own poll loop and queues it.
        await waitUntil(
          async () => (await client.getProposalState(proposalId)) === ProposalState.Queued,
          15_000,
          "the keeper to queue the proposal",
        );

        const timing = await client.getProposalTiming(proposalId);
        for (let i = 0; i < 20; i++) {
          const now = await client.timestamp();
          if (now >= timing.eta) break;
          await mineForward(client, 10);
        }

        // The keeper discovers the timelock ETA has passed and executes.
        await waitUntil(
          async () => (await client.getProposalState(proposalId)) === ProposalState.Executed,
          15_000,
          "the keeper to execute the proposal",
        );

        const finalState = await client.getProposalState(proposalId);
        expect(finalState).toBe(ProposalState.Executed);

        const decisions = await client.listDecisions(taskId);
        expect(decisions.length).toBeGreaterThanOrEqual(1);
        expect(decisions[0]?.kind).toBe("GRANT_EXCEPTION");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`keeper/worker smoke test failed; child process logs:\n${dumpLogs(children)}`);
        throw err;
      }
    },
    180_000,
  );
});

describe.skipIf(RUN_INTEGRATION)("keeper/worker smoke test (skipped)", () => {
  it("skips cleanly without FLEET_INTEGRATION=1 or a missing forge/anvil binary", () => {
    expect(RUN_INTEGRATION).toBe(false);
  });
});
