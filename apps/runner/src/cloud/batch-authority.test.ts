import { beforeEach, describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("./protected-records.js", () => ({ protectedRecord: read }));
import { BatchPlan, validateBatch, assertBatchLaunch } from "./batch-authority.js";
import { experimentDefaults } from "./experiment-settings.js";
const now = Date.now();
const settings = experimentDefaults();
const input = { name: "Overnight research", experiments: [settings, settings], maxBudgetUsd: 2, expiresAt: new Date(now + 12 * 3600_000).toISOString() };
const batchId = "batch-00000000-0000-4000-8000-000000000001";
const runId = "run-00000000-0000-4000-8000-000000000001";
const plan = BatchPlan.parse({ ...input, schema: "fleet.batch-plan.v1", batchId, requestedBy: "operator1@example.com", createdAt: new Date(now).toISOString(), runIds: [runId, "run-00000000-0000-4000-8000-000000000002"] });
const request = { schema: "fleet.simulation-request.v1" as const, runId, settings, requestedBy: "operator1@example.com" as const, createdAt: new Date(now).toISOString() };
beforeEach(() => { read.mockReset(); read.mockImplementation(async (path: string) => path === "batches/active.json" ? { value: { batchId } } : path.endsWith("/plan.json") ? { value: plan } : null); });
describe("bounded batch authority", () => {
  it("adds upper bounds rather than predicted costs", () => expect(validateBatch(input, now).reservedBudgetUsd).toBe(2));
  it("rejects over-budget, excessive runs and unbounded expiry", () => {
    expect(() => validateBatch({ ...input, maxBudgetUsd: 1 }, now)).toThrow("exceeds");
    expect(() => validateBatch({ ...input, experiments: Array(26).fill(settings), maxBudgetUsd: 30 }, now)).toThrow();
    for (const delta of [-1, 25 * 3600_000]) expect(() => validateBatch({ ...input, expiresAt: new Date(now + delta).toISOString() }, now)).toThrow("expire");
  });
  it("rejects forged owners, repeated identities and altered parameters", async () => {
    expect(() => BatchPlan.parse({ ...plan, requestedBy: "stranger@example.com" })).toThrow();
    expect(() => BatchPlan.parse({ ...plan, runIds: [runId, runId] })).toThrow();
    await expect(assertBatchLaunch({ ...request, requestedBy: "operator3@example.com" }, batchId)).rejects.toThrow("outside");
    await expect(assertBatchLaunch({ ...request, settings: { ...settings, budgetUsd: 0.5 } }, batchId)).rejects.toThrow("outside");
  });
  it("blocks manual runs during a batch and allows only its exact next settings", async () => {
    await expect(assertBatchLaunch(request)).rejects.toThrow("owns");
    await expect(assertBatchLaunch(request, batchId)).resolves.toBeUndefined();
  });
  it("refuses a cancelled batch before any new start", async () => {
    read.mockImplementation(async (path: string) => path.endsWith("/plan.json") ? { value: plan } : { value: { batchId } });
    await expect(assertBatchLaunch(request, batchId)).rejects.toThrow("outside");
  });
});
