import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ snapshots: [] as any[], calls: [] as any[], proposed: [] as string[], voted: [] as string[], work: null as any, allocation: null as any, halted: false, block: false, released: 0, chain: new Map<string, number>(), workCalls: 0 }));
vi.mock("node:fs", async () => ({ ...await vi.importActual<typeof import("node:fs")>("node:fs"), mkdirSync: vi.fn(), openSync: vi.fn(() => 10), writeSync: vi.fn(), fsyncSync: vi.fn(), closeSync: vi.fn() }));
vi.mock("./google.js", () => ({ readSecret: async (name: string) => name.includes("wallets") ? JSON.stringify({ schema: "fleet.wallets.v1", chainId: 84532, keys: Object.fromEntries(["FLEET_KEEPER_KEY", ...Array.from({ length: 5 }, (_, i) => `FLEET_AGENT_KEY_${i}`)].map((name, i) => [name, `0x${String(i + 1).padStart(64, "0")}`])) }) : "https://rpc.invalid",
  writeObject: async (_name: string, value: any) => { m.snapshots.push(value); } }));
vi.mock("./compute-store.js", () => ({ readComputeAllocation: async () => m.allocation, isComputeRunBlocked: async () => m.block,
  readComputeState: async () => ({ value: { allocationId: m.allocation.allocationId, phase: m.halted ? "halted" : "authorised", observedAt: Math.floor(Date.now() / 1000), approvedProposalIds: ["101", "102", "103"].slice(0, m.released), blockNumber: "900" } }) }));
vi.mock("./simulation.js", async () => ({ ...await vi.importActual<typeof import("./simulation.js")>("./simulation.js"), readSimulationWork: async () => m.work }));
vi.mock("../pipeline/inference-journal.js", () => ({ openInferenceJournal: () => ({ history: [], append() {}, close() {} }) }));
vi.mock("@fleet/sdk", async () => ({ ...await vi.importActual<typeof import("@fleet/sdk")>("@fleet/sdk"),
  MemoryNonceStore: class {}, NonceManager: class {},
  FleetClient: class {
    assertChain = async () => {};
    getProposalState = async (id: bigint) => m.chain.get(String(id)) ?? 1;
    publicClient = { waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 900n }), getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }) };
  },
  FleetSigner: class {
    address = `0x${"a".repeat(40)}`;
    propose = async () => { const id = String(101 + m.proposed.length); m.proposed.push(id); m.chain.set(id, 1); return { proposalId: BigInt(id), txHash: `0x${"b".repeat(64)}` }; };
  },
  Keeper: class {
    reconcileProposal = async (id: bigint) => { m.chain.set(String(id), 7); m.released++; return "executed"; };
  },
}));
vi.mock("@fleet/agent-runtime", async () => ({ ...await vi.importActual<typeof import("@fleet/agent-runtime")>("@fleet/agent-runtime"),
  OpenRouterProvider: class { name = "mock"; },
  InferenceScheduler: class { wrap = (provider: any) => provider; summary = () => ({ calls: m.workCalls }); close = async () => {}; },
  withOneRepair: async (_provider: any, request: any) => {
    m.workCalls++; m.calls.push(request);
    return { ok: true, value: { summary: "Observed a failing local test", message: "Can anyone reproduce this scorer mismatch?", concern: null, tool: "test_candidate", candidate: "sum" } };
  },
  ModelPolicy: class { evaluateProposal = async () => ({ kind: "vote", vote: { support: m.proposed.length === 3 ? "AGAINST" : "FOR", rationale: "Mock policy for orchestration test", proposalId: m.proposed.at(-1) } }); },
  Worker: class {
    constructor(private options: any) {}
    handleProposal = async (id: bigint) => {
      const result = await this.options.policy.evaluateProposal({});
      m.voted.push(String(id));
      if (m.voted.filter(x => x === String(id)).length === 5) m.chain.set(String(id), id === 103n ? 3 : 4);
      return { state: "voted", vote: result.vote, txHash: `0x${"c".repeat(64)}` };
    };
  },
}));
import { runCollectiveWorker } from "./collective-worker.js";
import { verifyActivity } from "../pipeline/activity-attestation.js";
import { COLLECTIVE_STEPS } from "./collective-scenario.js";
const runId = "run-00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.useFakeTimers(); m.snapshots = []; m.calls = []; m.proposed = []; m.voted = []; m.halted = false; m.block = false; m.released = 0; m.chain = new Map(); m.workCalls = 0;
  const now = Math.floor(Date.now() / 1000);
  const checkpoints = COLLECTIVE_STEPS.map((step, index) => ({ id: step.id, proposalId: String(101 + index), proposalTitle: step.title, proposalBody: step.context, decision: { kind: "CHOOSE_PATH", expectedVersion: 1 }, approvalDeadline: now + 540 * (index + 1), payloadHash: `0x${"d".repeat(64)}`, newCharterText: "" }));
  m.work = { scenario: "hf-collective-v1", runId, allocationId: "test-allocation", chainId: 84532, addresses: { governor: `0x${"1".repeat(40)}` }, taskId: "1", startBlock: "800", goal: "Investigate local benchmark", constitution: "Stay in scope", checkpoints };
  m.allocation = { ...m.work, governor: m.work.addresses.governor, requiredProposalIds: checkpoints.map(x => x.proposalId), stopAt: now + 2000, maxObservationAgeSeconds: 120 };
});
afterEach(() => { vi.useRealTimers(); process.exitCode = 0; });

it("runs five real code paths through work, signed evidence, two approvals and a third rejection without dispatching later work", async () => {
  const running = runCollectiveWorker(runId);
  await vi.runAllTimersAsync(); await running;
  expect(m.proposed).toEqual(["101", "102", "103"]);
  expect(m.voted).toHaveLength(15);
  expect(m.workCalls).toBe(30);
  const last = m.snapshots.at(-1);
  expect(last.phase).toBe("denied"); expect(last.terminal).toBe(true);
  expect(last.rounds.map((x: any) => x.outcome)).toEqual(["Executed", "Executed", "Defeated"]);
  const types = last.events.map((x: any) => x.type);
  expect(types.filter((x: string) => x === "work.resumed")).toHaveLength(3);
  expect(types.filter((x: string) => x === "checkpoint.work_completed")).toHaveLength(2);
  expect(types.at(-1)).toBe("vote.denied");
  expect(last.communication.messages).toHaveLength(20);
  expect(last.activity.length).toBeGreaterThan(100);
  expect((await Promise.all(last.activity.map(verifyActivity))).every(Boolean)).toBe(true);
  expect(last.activity.filter((record: any) => record.event.type === "tool_completed")[0].event.result.result.score).toBe("0/2");
});

it("does no model work and submits no proposals when the independent Guardian has halted authority", async () => {
  m.halted = true;
  const running = runCollectiveWorker(runId); await vi.runAllTimersAsync(); await running;
  expect(m.workCalls).toBe(0); expect(m.proposed).toEqual([]);
  expect(m.snapshots.at(-1).phase).toBe("failed");
});

it("cannot replay a retired run even if its earlier checkpoints were approved", async () => {
  m.block = true; m.released = 2;
  const running = runCollectiveWorker(runId); await vi.runAllTimersAsync(); await running;
  expect(m.workCalls).toBe(0); expect(m.proposed).toEqual([]); expect(m.voted).toEqual([]);
});
