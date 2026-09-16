import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { ActivityAttestor, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { agentRoster, simulationSnapshot } from "./simulation-view.js";
import { googleRequest, readObject } from "./google.js";
import { readComputeAllocation, readComputeAllocationById, readComputeState } from "./compute-store.js";
import { readSimulationRequest, readSimulationWork } from "./simulation.js";

vi.mock("./google.js", () => ({ BUCKET: "test-bucket", googleRequest: vi.fn(), readObject: vi.fn() }));
vi.mock("./compute-store.js", () => ({ readComputeAllocation: vi.fn(), readComputeAllocationById: vi.fn(), readComputeState: vi.fn(), readComputeEvidence: vi.fn(async () => null) }));
vi.mock("./simulation.js", () => ({ readSimulationRequest: vi.fn(), readSimulationWork: vi.fn(), simulationPath: (run: string) => run }));
const current = "run-00000000-0000-4000-8000-000000000001";
const previous = "run-00000000-0000-4000-8000-000000000002";
const original = agentRoster[0]!.address;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readSimulationRequest).mockResolvedValue({ runId: current } as never);
  vi.mocked(readComputeAllocation).mockResolvedValue({ runId: current, allocationId: "current" } as never);
  vi.mocked(readComputeAllocationById).mockResolvedValue({ runId: previous, allocationId: "previous" } as never);
  vi.mocked(readComputeState).mockResolvedValue({ value: { phase: "halted", observedVmStatus: "TERMINATED" } } as never);
  vi.mocked(readObject).mockResolvedValue({ runId: previous });
  vi.mocked(readSimulationWork).mockResolvedValue({ runId: previous, allocationId: "previous", taskId: "5" } as never);
  vi.mocked(googleRequest).mockResolvedValue(new Response(JSON.stringify({ id: "123", status: "RUNNING", machineType: "zones/a/machineTypes/e2-standard-8" })));
});
afterEach(() => { agentRoster[0]!.address = original; });

it("uses a historical run's saved allocation and VM observation instead of a later running worker", async () => {
  const snapshot = await simulationSnapshot(previous);
  expect(snapshot.isCurrentRun).toBe(false);
  expect(snapshot.vm.status).toBe("TERMINATED");
  expect(snapshot.allocation?.runId).toBe(previous);
  expect(readComputeState).toHaveBeenCalledWith("previous");
  expect(googleRequest).not.toHaveBeenCalled();
  expect((await simulationSnapshot()).vm.status).toBe("RUNNING");
});

it("preserves a failed preparation attempt even when it never published an allocation or proposal", async () => {
  vi.mocked(readSimulationWork).mockResolvedValue(null);
  vi.mocked(readObject).mockResolvedValue({ runId: previous, phase: "preparation-failed", terminal: true });
  const snapshot = await simulationSnapshot(previous);
  expect(snapshot.simulation?.runId).toBe(previous);
  expect(snapshot.simulationStatus?.phase).toBe("preparation-failed");
  expect(snapshot.allocation).toBeNull();
  expect(snapshot.vm.status).toBe("UNKNOWN");
  expect(googleRequest).not.toHaveBeenCalled();
});

it("only verifies signatures bound to this task, run and registered agent wallet", async () => {
  const key = `0x${"11".repeat(32)}` as const;
  agentRoster[0]!.address = privateKeyToAccount(key).address;
  const records: ActivityAttestation[] = [];
  const signer = new ActivityAttestor({ key, runId: previous, chainId: 84532, taskId: 5n, agentId: 0, record: value => records.push(value) });
  signer.record({ type: "review_started", task: "Review scope" }); await signer.flush();
  vi.mocked(readObject).mockResolvedValue({ runId: previous, activity: records });
  expect((await simulationSnapshot(previous)).activity).toEqual([expect.objectContaining({ signatureVerified: true })]);
  vi.mocked(readSimulationWork).mockResolvedValue({ runId: previous, allocationId: "previous", taskId: "6" } as never);
  expect((await simulationSnapshot(previous)).activity).toEqual([expect.objectContaining({ signatureVerified: false })]);
  records[0]!.event = { type: "fabricated_result" };
  vi.mocked(readSimulationWork).mockResolvedValue({ runId: previous, allocationId: "previous", taskId: "5" } as never);
  expect((await simulationSnapshot(previous)).activity).toEqual([expect.objectContaining({ signatureVerified: false })]);
});

it("keeps the beginning of a long run and never accepts a worker's claimed Guardian source", async () => {
  const events = [{ runId: previous, id: "e1", at: "2026-09-16T00:00:00Z", component: "compute", type: "claimed.stop", title: "Claim", detail: "Not independent proof", source: "Guardian" }];
  vi.mocked(readObject).mockResolvedValue({ runId: previous, events, activity: Array.from({ length: 125 }, (_, sequence) => ({ sequence, event: { type: "work_report" } })) });
  const snapshot = await simulationSnapshot(previous);
  expect(snapshot.activity).toHaveLength(125);
  expect(snapshot.activity[0]?.sequence).toBe(0);
  expect(snapshot.activity.every(record => !record.signatureVerified)).toBe(true);
  expect(snapshot.events[0]?.source).toBe("Worker report · inspect the supporting evidence");
});

it("coalesces concurrent public reads, retains observation time and retries failed reads", async () => {
  const { coalescedReader } = await import("./simulation-view.js");
  let resolve!: (value: { observedAt: string }) => void;
  const read = vi.fn(() => new Promise<{ observedAt: string }>(done => { resolve = done; }));
  const cached = coalescedReader(read, 4000);
  const first = cached("a"), second = cached("a");
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  resolve({ observedAt: "2026-09-16T00:00:00Z" });
  expect(await first).toEqual(await second);
  expect(await cached("a")).toEqual({ observedAt: "2026-09-16T00:00:00Z" });
  expect(read).toHaveBeenCalledTimes(1);
  const flaky = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("fresh");
  const retry = coalescedReader(flaky, 4000);
  await expect(retry()).rejects.toThrow("offline");
  expect(await retry()).toBe("fresh");
  expect(flaky).toHaveBeenCalledTimes(2);
});

it("resolves a later published checkpoint to its own exact proposal body", async () => {
  const { simulationProposal } = await import("./simulation-view.js");
  vi.mocked(googleRequest).mockResolvedValue(new Response(JSON.stringify({ items: [{ name: `demo/simulations/${previous}/status.json`, updated: "2026-09-16T00:00:00Z" }] })));
  vi.mocked(readObject).mockResolvedValue({ runId: previous, proposalId: "999", rounds: [{ proposalId: "111", phase: "approved", txHash: "0xreceipt" }, { proposalId: "222", phase: "denied", txHash: "0xreceipt" }, { proposalId: "999", phase: "planned" }] });
  vi.mocked(readSimulationWork).mockResolvedValue({ runId: previous, proposalId: "111", checkpoints: [{ proposalId: "111", proposalBody: "first" }, { proposalId: "222", proposalBody: "second" }, { proposalId: "999", proposalBody: "unsubmitted" }] } as never);
  expect(await simulationProposal("222")).toMatchObject({ proposalId: "222", proposalBody: "second", checkpointIndex: 1 });
  expect(await simulationProposal("999")).toBeNull();
});


it("resolves an agent-authored proposal from its published round without a prewritten work manifest", async () => {
  vi.resetModules();
  const { simulationProposal } = await import("./simulation-view.js");
  vi.mocked(googleRequest).mockResolvedValue(new Response(JSON.stringify({ items: [{ name: `demo/simulations/${previous}/status.json`, updated: "2026-09-16T01:00:00Z" }] })));
  vi.mocked(readObject).mockResolvedValue({ runId: previous, rounds: [{ proposalId: "333", phase: "voting", txHash: "0xreceipt", title: "Agent request", proposalBody: "Model-written body", proposerAgentId: 4, creditTxHash: "0xcredit" }, { proposalId: "444", phase: "proposing" }] });
  vi.mocked(readSimulationWork).mockResolvedValue({ runId: previous, agentDriven: { allowance: 3 }, constitution: "Scope" } as never);
  expect(await simulationProposal("333")).toMatchObject({ proposalOrigin: "agent", proposalBody: "Model-written body", proposerAgentId: 4, creditTxHash: "0xcredit" });
  expect(await simulationProposal("444")).toBeNull();
});
