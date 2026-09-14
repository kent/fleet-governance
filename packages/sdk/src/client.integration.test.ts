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
import { agoraGovernorAbi, fleetHookAbi, taskLedgerAbi } from "@fleet/abi";
import {
  FleetClient,
  ProposalState,
  addressesFromManifest,
  buildDecisionDescription,
  encodeRecordDecision,
  getDecisionTrace,
  payloadHashForAction,
  renderVoteReason,
  verifyDescriptionAgainstCalldata,
} from "./index.js";
import type { DecisionV1 } from "@fleet/schemas";
import type { DecisionTraceEvent } from "./trace.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(currentDir, "../../../contracts");
const manifestOutPath = path.join(contractsDir, ".fleet-manifest-tmp.json");

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

/** Parses Anvil's own startup banner for its deterministic dev accounts and private keys, rather
 *  than hardcoding them, so this test is correct regardless of which Anvil version or mnemonic
 *  produced the log. */
function parseAnvilAccounts(output: string): AnvilAccount[] {
  const accountsSection = output.split("Available Accounts")[1]?.split("Private Keys")[0] ?? "";
  const keysSection = output.split("Private Keys")[1]?.split(/Wallet|Base Fee|Gas/)[0] ?? "";
  const addrs = new Map<number, Address>(
    [...accountsSection.matchAll(/\((\d+)\)\s+(0x[0-9a-fA-F]{40})\b/g)].map((m) => [
      Number(m[1]),
      m[2] as Address,
    ]),
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

/** Spawns Anvil on a random free port with `--block-time 1` (amendment 7: real interval mining,
 *  not instant-per-tx, so `evm_increaseTime` + `evm_mine` are what skip waits, not wall-clock
 *  sleep) and waits for its "Listening on" line before returning its parsed dev accounts. */
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

/** Runs the Part 1 deploy script against a running Anvil, per contracts/README.md's "Deploying
 *  locally" recipe. `FLEET_MANIFEST_OUT` must resolve inside `contracts/`'s `fs_permissions`
 *  (`foundry.toml` allows read-write only under `./` and `../deployments`), hence the fixed,
 *  gitignored `contracts/.fleet-manifest-tmp.json` path rather than a system tmp directory. */
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
 *  schema, so the method/params casts below are the standard escape hatch for an otherwise
 *  untyped JSON-RPC call through a typed client. */
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

describe.skipIf(!RUN_INTEGRATION)("FleetClient against a live Anvil deployment", () => {
  let anvil: AnvilHandle;
  let client: FleetClient;
  let operator: ReturnType<typeof walletFor>;
  let members: ReturnType<typeof walletFor>[];
  let calldata: Hex;
  let description: string;
  let descriptionHash: Hex;
  let proposalId: bigint;
  let taskId: bigint;
  let decisionSummary: string;
  const scenarioStart = Date.now();

  beforeAll(async () => {
    anvil = await startAnvil();
    const deployer = anvil.accounts.find((a) => a.index === 0);
    const operatorAccount = anvil.accounts.find((a) => a.index === 6);
    const memberAccounts = [1, 2, 3, 4, 5].map((i) => anvil.accounts.find((a) => a.index === i));
    if (!deployer || !operatorAccount || memberAccounts.some((m) => !m)) {
      throw new Error("Anvil did not report the expected dev accounts 0 through 6");
    }

    deployWithForge(anvil.rpcUrl, deployer.key);
    const manifest = ManifestV1.parse(JSON.parse(readFileSync(manifestOutPath, "utf8")));
    const addresses = addressesFromManifest(manifest);
    client = new FleetClient({ rpcUrl: anvil.rpcUrl, chainId: manifest.chainId, addresses });

    operator = walletFor(anvil.rpcUrl, manifest.chainId, operatorAccount.key);
    members = memberAccounts.map((m) => walletFor(anvil.rpcUrl, manifest.chainId, (m as AnvilAccount).key));

    // The operator opens a task via a raw viem wallet (amendment 7), not through FleetClient,
    // which is read-only.
    const charterText = JSON.stringify({
      schema: "fleet.charter.v1",
      goal: "Integration test task",
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

    // Agent 1 (registry agentId 0) proposes with encodeRecordDecision and buildDecisionDescription.
    const action = { class: "read_repo" as const, target: "repo", argsHash: `0x${"11".repeat(32)}` as Hex };
    const payloadHash = payloadHashForAction(action);
    decisionSummary = "Grant a one-time exception for the integration test.";
    calldata = encodeRecordDecision({
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
      rationale: "The integration test needs one recorded decision to exercise the whole lifecycle.",
      assumptions: [],
      riskFlags: [],
    };
    description = buildDecisionDescription(decision, "Planner");

    const proposeHash = await members[0]!.writeContract({
      address: addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "propose",
      args: [[addresses.ledger], [0n], [calldata], description],
    });
    await members[0]!.waitForTransactionReceipt({ hash: proposeHash });
    descriptionHash = keccak256(toHex(description));
    proposalId = await client.publicClient.readContract({
      address: addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "hashProposal",
      args: [[addresses.ledger], [0n], [calldata], descriptionHash],
    });

    await waitForState(client, proposalId, ProposalState.Active);

    // Cast 3 For + 2 Against with renderVoteReason.
    for (let i = 0; i < members.length; i++) {
      const support: "FOR" | "AGAINST" = i < 3 ? "FOR" : "AGAINST";
      const reason = renderVoteReason({
        schema: "fleet.vote.v1",
        proposalId: proposalId.toString(),
        support,
        rationale: `Member ${i} voting ${support.toLowerCase()} for the integration test.`,
        assumptions: [],
        riskFlags: [],
        confidenceBps: 8000,
      });
      const voteHash = await members[i]!.writeContract({
        address: addresses.governor,
        abi: agoraGovernorAbi,
        functionName: "castVoteWithReason",
        args: [proposalId, support === "FOR" ? 1 : 0, reason],
      });
      await members[i]!.waitForTransactionReceipt({ hash: voteHash });
    }

    await waitForState(client, proposalId, ProposalState.Succeeded);

    const queueHash = await operator.writeContract({
      address: addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "queue",
      args: [[addresses.ledger], [0n], [calldata], descriptionHash],
    });
    await operator.waitForTransactionReceipt({ hash: queueHash });

    // Skip the timelock delay (30s locally) plus a margin, then execute via the raw wallet.
    await mineForward(client, 60);
    const executeHash = await operator.writeContract({
      address: addresses.governor,
      abi: agoraGovernorAbi,
      functionName: "execute",
      args: [[addresses.ledger], [0n], [calldata], descriptionHash],
    });
    await operator.waitForTransactionReceipt({ hash: executeHash });
  }, 180_000);

  afterAll(() => {
    if (anvil) stopAnvil(anvil);
    if (existsSync(manifestOutPath)) rmSync(manifestOutPath, { force: true });
    // eslint-disable-next-line no-console
    console.log(`FleetClient integration scenario runtime: ${Date.now() - scenarioStart}ms`);
  });

  it("opens a task the client can read back", async () => {
    const task = await client.getTask(taskId);
    expect(task.operator.toLowerCase()).toBe(operator.account.address.toLowerCase());
    expect(task.charterVersion).toBe(1);
    expect(task.charter?.schema).toBe("fleet.charter.v1");
  });

  it("getProposalCreated returns the exact description that was proposed", async () => {
    const created = await client.getProposalCreated(proposalId);
    expect(created.description).toBe(description);
    expect(created.targets[0]?.toLowerCase()).toBe(client.addresses.ledger);
    expect(created.calldatas[0]).toBe(calldata);
  });

  it("verifyDescriptionAgainstCalldata reports ok for the actual proposer", async () => {
    const result = verifyDescriptionAgainstCalldata(description, calldata, { agentId: 0 });
    expect(result).toEqual({ ok: true });
  });

  it("listVotes returns all 5 votes with parsed reasons", async () => {
    const votes = await client.listVotes(proposalId);
    expect(votes).toHaveLength(5);
    const forCount = votes.filter((v) => v.support === 1).length;
    const againstCount = votes.filter((v) => v.support === 0).length;
    expect(forCount).toBe(3);
    expect(againstCount).toBe(2);
    for (const vote of votes) {
      expect(vote.parsedReason.support).toBe(vote.support === 1 ? "FOR" : "AGAINST");
      expect(vote.parsedReason.confidence).toBe(0.8);
    }
  });

  it("reached Succeeded before queue and Executed after execute", async () => {
    const state = await client.getProposalState(proposalId);
    expect(state).toBe(ProposalState.Executed);
  });

  it("getDecisionTrace joins DecisionProposed and DecisionRecorded on actionId, matching hook.actionOf", async () => {
    const trace = await getDecisionTrace(client, proposalId);
    expect(trace.taskId).toBe(taskId);

    const hookActionId = await client.publicClient.readContract({
      address: client.addresses.hook,
      abi: fleetHookAbi,
      functionName: "actionOf",
      args: [proposalId],
    });
    expect(trace.actionId).toBe(hookActionId);

    const eventTypes = trace.events.map((e) => e.type);
    expect(eventTypes).toContain("TaskOpened");
    expect(eventTypes).toContain("ProposalCreated");
    expect(eventTypes).toContain("DecisionProposed");
    expect(eventTypes.filter((t) => t === "VoteCast")).toHaveLength(5);
    expect(eventTypes).toContain("ProposalQueued");
    expect(eventTypes).toContain("ProposalExecuted");
    expect(eventTypes).toContain("DecisionRecorded");

    const decisionRecorded = trace.events.find((e) => e.type === "DecisionRecorded");
    expect(decisionRecorded && decisionRecorded.type === "DecisionRecorded" && decisionRecorded.actionId).toBe(
      hookActionId,
    );
    expect(decisionRecorded && decisionRecorded.type === "DecisionRecorded" && decisionRecorded.summary).toBe(
      decisionSummary,
    );

    // Events are ordered by block then log index: TaskOpened/ProposalCreated/DecisionProposed
    // precede every vote, which precede queue/execute/record.
    const indexOf = (t: DecisionTraceEvent["type"]) => eventTypes.indexOf(t);
    expect(indexOf("ProposalCreated")).toBeLessThan(indexOf("DecisionProposed"));
    expect(indexOf("DecisionProposed")).toBeLessThan(eventTypes.findIndex((t) => t === "VoteCast"));
    expect(indexOf("ProposalQueued")).toBeLessThan(indexOf("ProposalExecuted"));
    expect(indexOf("DecisionRecorded")).toBeLessThanOrEqual(indexOf("ProposalExecuted") + 1);
  });

  it("listDecisions returns the recorded GRANT_EXCEPTION decision", async () => {
    const decisions = await client.listDecisions(taskId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.kind).toBe("GRANT_EXCEPTION");
    expect(decisions[0]?.summary).toBe(decisionSummary);
  });
});

describe.skipIf(RUN_INTEGRATION)("FleetClient integration (skipped)", () => {
  it("skips cleanly without FLEET_INTEGRATION=1 or a missing forge/anvil binary", () => {
    expect(RUN_INTEGRATION).toBe(false);
  });
});
