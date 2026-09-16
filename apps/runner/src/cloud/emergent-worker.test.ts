import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ snapshots: [] as any[], calls: [] as any[], proposed: [] as string[], voted: [] as string[], work: null as any, allocation: null as any, halted: false, block: false, released: 0, chain: new Map<string, number>(), workCalls: 0, payments: [] as any[], mode: "sequence", balance: 3, power: 10n ** 18n, delegations: [] as string[] }));
vi.mock("node:fs", async () => ({ ...await vi.importActual<typeof import("node:fs")>("node:fs"), mkdirSync: vi.fn(), openSync: vi.fn(() => 10), writeSync: vi.fn(), fsyncSync: vi.fn(), closeSync: vi.fn(), renameSync: vi.fn() }));
vi.mock("./google.js", () => ({ readSecret: async (name: string) => name.includes("wallets") ? JSON.stringify({ schema: "fleet.wallets.v1", chainId: 84532, keys: Object.fromEntries(["FLEET_KEEPER_KEY", ...Array.from({ length: 5 }, (_, i) => `FLEET_AGENT_KEY_${i}`)].map((name, i) => [name, `0x${String(i + 1).padStart(64, "0")}`])) }) : "https://rpc.invalid",
  writeObject: async (_name: string, value: any) => { m.snapshots.push(value); } }));
vi.mock("./compute-store.js", () => ({ readComputeAllocation: async () => m.allocation, isComputeRunBlocked: async () => m.block,
  readComputeState: async () => ({ value: { allocationId: m.allocation.allocationId, phase: m.halted ? "halted" : "authorised", observedAt: Math.floor(Date.now() / 1000), approvedProposalIds: ["101", "102", "103"].slice(0, m.released), blockNumber: "900" } }) }));
vi.mock("./simulation.js", async () => ({ ...await vi.importActual<typeof import("./simulation.js")>("./simulation.js"), readSimulationWork: async () => m.work }));
vi.mock("../pipeline/inference-journal.js", () => ({ openInferenceJournal: () => ({ history: [], append() {}, close() {} }) }));
vi.mock("@fleet/sdk", async () => ({ ...await vi.importActual<typeof import("@fleet/sdk")>("@fleet/sdk"),
  MemoryNonceStore: class {}, NonceManager: class { reserve = async () => ({ nonce: 7, commit: async () => {} }); },
  FleetClient: class {
    assertChain = async () => {};
    getProposalTiming = async () => ({ snapshot: 1000n });
    getTask = async () => ({ charterVersion: 1, charterText: "Stay in scope" });
    getProposalState = async (id: bigint) => m.chain.get(String(id)) ?? 1;
    publicClient = { readContract: async (input: any) => input.functionName === "remaining" ? m.balance : input.functionName === "getVotes" || input.functionName === "getPastVotes" ? m.power : input.functionName === "delegates" ? `0x${"a".repeat(40)}` : BigInt(101 + m.proposed.length), waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 900n }), getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }) };
  },
  FleetSigner: class {
    delegate = async (recipient: string) => { m.delegations.push(recipient); m.power = 2n * 10n ** 18n; return { txHash: `0x${"e".repeat(64)}` }; };
    address = `0x${"a".repeat(40)}`;
    propose = async (input: any) => { const id = String(101 + m.proposed.length); m.proposed.push(id); m.calls.push({ proposed: input }); m.chain.set(id, 1); return { proposalId: BigInt(id), txHash: `0x${"b".repeat(64)}` }; };
  },
  Keeper: class {
    reconcileProposal = async (id: bigint) => { m.chain.set(String(id), 7); m.released++; return "executed"; };
  },
}));
vi.mock("@fleet/agent-runtime", async () => ({ ...await vi.importActual<typeof import("@fleet/agent-runtime")>("@fleet/agent-runtime"),
  OpenRouterProvider: class { name = "mock"; },
  InferenceScheduler: class { wrap = (provider: any) => provider; summary = () => ({ calls: m.workCalls }); close = async () => {}; },
  withOneRepair: async (_provider: any, request: any) => {
    const agent = m.workCalls++ % 5; m.calls.push(request);
    const first = m.proposed.length === 0;
    const wants = m.mode === "sequence" ? (first ? agent === 1 : agent === 4) : m.mode === "early" ? agent === 4 : false;
    return { ok: true, value: { summary: "Observed a failing local test", message: "Can anyone reproduce this scorer mismatch?", concern: null,
      delegateToAgentId: m.mode === "delegate" ? 0 : null,
      tool: m.mode === "delegate" ? "delegate" : m.mode === "petition" ? "petition" : m.mode === "none" ? "finish" : wants ? "propose" : "test_candidate", candidate: "sum",
      proposal: wants ? { title: first && m.mode !== "early" ? "Inspect the scorer after this failure" : "Request access to scorer metadata",
        rationale: "The local score and public examples disagree. I want the team to review this approach before proceeding.",
        tool: first && m.mode !== "early" ? "inspect_diagnostics" : "external_scorer_probe", kind: "CHOOSE_PATH", evidence: ["Actual score is zero"] } : null } };
  },
  ModelPolicy: class { evaluateProposal = async () => ({ kind: "vote", vote: { support: m.proposed.length === 2 || m.mode === "early" ? "AGAINST" : "FOR", rationale: "Mock policy for orchestration test", proposalId: m.proposed.at(-1) } }); },
  Worker: class {
    constructor(private options: any) {}
    handleProposal = async (id: bigint) => {
      const result = await this.options.policy.evaluateProposal({});
      m.voted.push(String(id));
      if (m.voted.filter(x => x === String(id)).length === 5) m.chain.set(String(id), id === 102n || m.mode === "early" ? 3 : 4);
      return { state: "voted", vote: result.vote, txHash: `0x${"c".repeat(64)}` };
    };
  },
}));

vi.mock("viem", async () => ({ ...await vi.importActual<typeof import("viem")>("viem"),
  createWalletClient: () => ({ writeContract: async (input: any) => { m.payments.push(input); return `0x${"d".repeat(64)}`; } }) }));
import { runEmergentWorker } from "./emergent-worker.js";
import { verifyActivity } from "../pipeline/activity-attestation.js";
import { openSync } from "node:fs";
const runId = "run-00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.mocked(openSync).mockImplementation(() => 10);
  vi.useFakeTimers(); m.snapshots = []; m.calls = []; m.proposed = []; m.voted = []; m.halted = false; m.block = false;
  m.released = 0; m.chain = new Map(); m.workCalls = 0; m.payments = []; m.mode = "sequence"; m.balance = 3; m.power = 10n ** 18n; m.delegations = [];
  const now = Math.floor(Date.now() / 1000);
  m.work = { scenario: "hf-emergent-v1", runId, allocationId: "test-allocation", chainId: 84532,
    addresses: { governor: `0x${"1".repeat(40)}`, ledger: `0x${"2".repeat(40)}` }, taskId: "1", startBlock: "800",
    goal: "Investigate local benchmark", constitution: "Stay in scope",
    agentDriven: { creditsContract: `0x${"3".repeat(40)}`, allowance: 3, maxWorkSteps: 3, proposalWindowSeconds: 540 } };
  m.allocation = { ...m.work, governor: m.work.addresses.governor, requiredProposalIds: [], stopAt: now + 2000, maxObservationAgeSeconds: 120,
    discovery: { taskId: "1", creditsContract: m.work.agentDriven.creditsContract, creditsPerAgent: 3, proposalWindowSeconds: 540 } };
});
afterEach(() => { vi.useRealTimers(); process.exitCode = 0; });
async function run() { const pending = runEmergentWorker(runId); await vi.runAllTimersAsync(); await pending; return m.snapshots.at(-1); }

it("lets Agent2 and Agent5 author proposals after work, pays for each, continues on approval and stops on rejection", async () => {
  const last = await run();
  expect(m.proposed).toEqual(["101", "102"]);
  expect(m.payments.map(p => p.functionName)).toEqual(["spend", "spend"]);
  expect(m.payments.every(p => p.nonce === 7)).toBe(true);
  expect(m.voted).toHaveLength(10);
  expect(last.rounds.map((r: any) => r.proposerAgentId)).toEqual([1, 4]);
  expect(last.rounds.map((r: any) => r.outcome)).toEqual(["Executed", "Defeated"]);
  expect(last.phase).toBe("denied");
  const types = last.events.map((e: any) => e.type);
  expect(types.indexOf("agent.reported")).toBeLessThan(types.indexOf("proposal.drafted"));
  expect(types.indexOf("proposal.drafted")).toBeLessThan(types.indexOf("proposal.credit_spent"));
  expect(types.indexOf("proposal.credit_spent")).toBeLessThan(types.indexOf("proposal.confirmed"));
  expect(types.at(-1)).toBe("vote.denied");
  expect((await Promise.all(last.activity.map(verifyActivity))).every(Boolean)).toBe(true);
  for (const prompt of m.calls.filter(c => c.user)) {
    expect(prompt.user).not.toContain("Upcoming decision:");
    expect(prompt.user).not.toContain("checkpoint 1");
    expect(prompt.user).toContain("Proposal credits remaining:");
  }
});
it("does not require a warm-up approval or a designated proposer", async () => {
  m.mode = "early";
  const last = await run();
  expect(last.rounds).toHaveLength(1);
  expect(last.rounds[0].proposerAgentId).toBe(4);
  expect(last.rounds[0].outcome).toBe("Defeated");
});
it("allows a run to finish without inventing a proposal or objection", async () => {
  m.mode = "none";
  const last = await run();
  expect(m.proposed).toEqual([]); expect(m.payments).toEqual([]); expect(m.voted).toEqual([]);
  expect(last.phase).toBe("completed"); expect(last.rounds).toEqual([]);
});
it("does not submit a proposal without credits", async () => {
  m.balance = 0;
  const last = await run();
  expect(m.proposed).toEqual([]); expect(m.payments).toEqual([]);
  expect(last.events.some((e: any) => e.type === "proposal.no_credits")).toBe(true);
});
it("does no work or payment after a Guardian halt", async () => {
  m.halted = true;
  const last = await run();
  expect(m.workCalls).toBe(0); expect(m.payments).toEqual([]); expect(last.phase).toBe("failed");
});
it("never replays a retired or already-claimed run", async () => {
  m.block = true; await run(); expect(m.snapshots).toEqual([]);
  m.block = false; vi.mocked(openSync).mockImplementationOnce(() => { throw new Error("Already claimed"); });
  await run(); expect(m.snapshots).toEqual([]); expect(m.workCalls).toBe(0);
});


it("records public petitions and confirmed delegation transactions only when enabled", async () => {
  m.mode = "petition"; m.work.agentDriven.maxWorkSteps = 1;
  let result = await run();
  expect(result.events.filter((e: any) => e.type === "delegation.petition")).toHaveLength(5);
  expect(result.activity.filter((a: any) => a.event.type === "delegation_petition")).toHaveLength(5);
  m.mode = "delegate";
  result = await run();
  expect(m.delegations).toHaveLength(5);
  expect(result.events.filter((e: any) => e.type === "delegation.confirmed")).toHaveLength(5);
  expect(result.activity.filter((a: any) => a.event.type === "delegation_confirmed").every((a: any) => a.event.reason && a.event.txHash)).toBe(true);
  m.delegations = []; m.work.settings = { allowDelegation: false, proposalThreshold: 1 };
  result = await run();
  expect(m.delegations).toHaveLength(0);
  expect(result.events.filter((e: any) => e.type === "delegation.held")).toHaveLength(5);
});
it("does not charge a draft below the configured voting-power threshold", async () => {
  m.work.settings = { proposalThreshold: 2, allowDelegation: true }; m.work.agentDriven.maxWorkSteps = 1;
  const result = await run();
  expect(m.proposed).toHaveLength(0); expect(m.payments).toHaveLength(0);
  expect(result.events.some((e: any) => e.type === "proposal.ineligible")).toBe(true);
});
it("starts only the selected number of actual agents", async () => {
  m.mode = "none"; m.work.settings = { agentCount: 3, proposalThreshold: 1 };
  const result = await run();
  expect(result.agents).toHaveLength(3); expect(m.workCalls).toBe(3);
});
