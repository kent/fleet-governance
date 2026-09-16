import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), build: vi.fn(), hash: vi.fn(), arm: vi.fn(), control: vi.fn(), request: vi.fn(), write: vi.fn() }));
vi.mock("../pipeline/task.js", () => ({ openTask: mocks.open }));
vi.mock("../pipeline/fixture-runner.js", () => ({ buildTriggerDecision: mocks.build, computeTriggerProposalId: mocks.hash }));
vi.mock("./compute-admin.js", async () => ({ ...await vi.importActual<typeof import("./compute-admin.js")>("./compute-admin.js"), armComputeAllocation: mocks.arm, writeControlObject: mocks.control }));
vi.mock("./google.js", () => ({ googleRequest: mocks.request, writeObject: mocks.write }));
import { prepareCollective } from "./collective-prepare.js";
const runId = "run-00000000-0000-4000-8000-000000000001";
const args = { request: { runId, schema: "fleet.simulation-request.v1", requestedBy: "operator2@example.com", createdAt: new Date().toISOString(), scenario: "hf-collective-v1" }, client: {}, rpcUrl: "https://rpc.example.invalid", addresses: { governor: `0x${"1".repeat(40)}` }, keys: { operatorKey: "test-key-must-not-leak" }, constitution: "Review scope independently", startBlock: 99n } as unknown as Parameters<typeof prepareCollective>[0];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.request.mockResolvedValue({ json: async () => ({ id: "1", status: "RUNNING", lastStartTimestamp: new Date().toISOString(), scheduling: { automaticRestart: false, instanceTerminationAction: "STOP" }, resourceStatus: { scheduling: { terminationTimestamp: new Date(Date.now() + 3600000).toISOString() } } }) });
  mocks.open.mockResolvedValue({ taskId: 10n, blockNumber: 100n, txHash: `0x${"a".repeat(64)}` });
  mocks.build.mockImplementation(async (_ctx, _task, fixture) => ({ description: fixture.description, payloadHash: `0x${"b".repeat(64)}`, newCharterText: "", decision: { expectedVersion: 1, kind: "CHOOSE_PATH" } }));
  let next = 0; mocks.hash.mockImplementation(async () => BigInt(++next));
  mocks.arm.mockImplementation(async request => ({ ...request, allocationId: "00000000-0000-4000-8000-000000000002", stopAt: Math.floor(Date.now() / 1000) + 3600 }));
});
it("pins all exact future decisions and deadlines before publishing work, without publishing a vote early", async () => {
  const work = await prepareCollective(args);
  expect(mocks.hash).toHaveBeenCalledTimes(3);
  expect(mocks.arm.mock.calls[0]![0].requiredProposalIds).toEqual(["1", "2", "3"]);
  expect(work.checkpoints?.map(x => x.proposalId)).toEqual(["1", "2", "3"]);
  expect(work.checkpoints![1]!.approvalDeadline - work.checkpoints![0]!.approvalDeadline).toBe(540);
  expect(work.proposeTxHash).toBeUndefined();
  expect(mocks.control).toHaveBeenCalledTimes(1);
  expect(mocks.control).toHaveBeenCalledWith(`simulations/${runId}/work.json`, work);
  expect(mocks.open.mock.calls[0]![0].charter.externalAllowlist).toEqual([]);
  expect(work.preparationEvents?.map(x => x.type)).toEqual(["task.assigned", "compute.observed_running", "task.opened", "allocation.armed"]);
  expect(JSON.stringify(work)).not.toContain("test-key-must-not-leak");
});
it("refuses to prepare a checkpoint plan when the VM cannot cover its fixed deadlines", async () => {
  mocks.request.mockResolvedValue({ json: async () => ({ id: "1", status: "RUNNING", scheduling: { automaticRestart: false, instanceTerminationAction: "STOP" }, resourceStatus: { scheduling: { terminationTimestamp: new Date(Date.now() + 1200000).toISOString() } } }) });
  await expect(prepareCollective(args)).rejects.toThrow("35 minutes");
  expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.arm).not.toHaveBeenCalled(); expect(mocks.control).not.toHaveBeenCalled();
});
it("does not publish work when arming the immutable allocation fails", async () => {
  mocks.arm.mockRejectedValue(new Error("already armed"));
  await expect(prepareCollective(args)).rejects.toThrow("already armed");
  expect(mocks.control).not.toHaveBeenCalled();
});
