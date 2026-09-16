import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ read: vi.fn(), control: vi.fn(), work: vi.fn(), request: vi.fn() }));
vi.mock("./google.js", () => ({ BUCKET: "test", googleRequest: m.request, readObject: m.read }));
vi.mock("./compute-store.js", () => ({ readComputeObject: m.control }));
vi.mock("./simulation.js", () => ({ readSimulationWork: m.work, simulationPath: (id: string, file = "status.json") => `demo/simulations/${id}/${file}` }));
vi.mock("./simulation-view.js", () => ({ coalescedReader: (read: any) => read }));
vi.mock("./control.js", () => ({ RUN_ID: /^run-[0-9a-f-]{36}$/, runPath: (id: string, file: string) => `demo/runs/${id}/${file}` }));
import { experimentRecord, experimentIndex } from "./experiment-records.js";
const id = "run-00000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.resetAllMocks(); m.control.mockResolvedValue(null); m.read.mockResolvedValue(null); m.work.mockResolvedValue(null); });
it("makes the protected experiment settings authoritative over mutable display metadata", async () => {
  const settings = { name: "Delegation lab", agentCount: 5, budgetUsd: 0.5, goal: "Investigate the scorer" };
  m.control.mockResolvedValue({ runId: id, settings, createdAt: "2026-09-16T00:00:00Z" });
  m.read.mockImplementation(async (path: string) => path.includes("simulations") ? path.endsWith("request.json") ? { settings: { ...settings, budgetUsd: 999 } } : { rounds: [{ txHash: "0xreceipt", votes: [{},{}] }, { phase: "draft" }], events: [{ type: "delegation.confirmed" }], inference: { budget: { chargedCostUsd: 0.01 } } } : null);
  expect((await experimentRecord(id))?.experiment).toMatchObject({ settings, proposals: 1, ballots: 2, delegations: 1, configurationSource: "Protected operator record" });
});
it("keeps historical fixed proposals labelled as the earlier design instead of applying new defaults", async () => {
  m.work.mockResolvedValue({ runId: id, checkpoints: [{ proposalId: "1" }], goal: "Historical task", scenario: "hf-collective-v1" });
  expect((await experimentRecord(id))?.experiment).toMatchObject({ name: "Recorded checkpoint experiment", settings: null, scenario: "hf-collective-v1", goal: "Historical task" });
});
it("lists every page and merges simulation and legacy records without duplicate experiment IDs", async () => {
  m.work.mockResolvedValue({ runId: id, goal: "Task" });
  m.request.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ name: `demo/simulations/${id}/status.json` }], nextPageToken: "page2" })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ name: `demo/simulations/${id}/request.json` }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })));
  expect(await experimentIndex()).toHaveLength(1);
  expect(m.request.mock.calls[1]?.[1]).toContain("pageToken=page2");
});
