import { expect, it, vi } from "vitest";
import { CloudError } from "./google.js";
import { ACTIVE, queueDemo, runPath, type ControlDeps } from "./control.js";

const first = "run-00000000-0000-4000-8000-000000000001";
const second = "run-00000000-0000-4000-8000-000000000002";
const settings = { agentCount: 5, goal: "Fix the library and request publication.", constitution: "existing" };
function fixture() {
  const objects = new Map<string, { value: unknown; generation: string }>();
  let generation = 0;
  const start = vi.fn(async () => {});
  const deps: ControlDeps = {
    read: async <T>(key: string) => (objects.get(key)?.value as T | undefined) ?? null,
    readVersion: async <T>(key: string) => (objects.get(key) as { value: T; generation: string } | undefined) ?? null,
    write: async (key, value, match) => {
      const expected = typeof match === "string" ? match : match ? "0" : null;
      if (expected !== null && (objects.get(key)?.generation ?? "0") !== expected) throw new CloudError(412, "storage");
      objects.set(key, { value: structuredClone(value), generation: String(++generation) });
    }, start, now: () => "2026-09-15T00:00:00Z", revision: "test-revision",
  };
  return { objects, deps, start };
}
it("claims one worker under concurrent requests and records the losing request as unqueued", async () => {
  const { deps, objects, start } = fixture();
  const outcomes = await Promise.allSettled([queueDemo(settings, first, deps), queueDemo(settings, second, deps)]);
  expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(start).toHaveBeenCalledTimes(1);
  expect(objects.get(ACTIVE)?.value).toEqual({ runId: first });
  expect(objects.get(runPath(second, "status.json"))?.value).toMatchObject({ phase: "not-queued", terminal: true });
});
it("retries a failed VM start with the same request and never restarts a completed run", async () => {
  const { deps, start } = fixture();
  start.mockRejectedValueOnce(new Error("start unavailable"));
  await expect(queueDemo(settings, first, deps)).rejects.toThrow("unavailable");
  const run = await queueDemo(settings, first, deps);
  expect(run.runId).toBe(first);
  await deps.write(runPath(first, "status.json"), { terminal: true });
  await queueDemo(settings, first, deps);
  expect(start).toHaveBeenCalledTimes(2);
  await expect(queueDemo({ ...settings, goal: "Change the existing request." }, first, deps)).rejects.toThrow("different settings");
});
it("recovers a request saved before queue acquisition without changing its configuration", async () => {
  const { deps } = fixture();
  await deps.write(runPath(first, "request.json"), { runId: first, settings, revision: "original", createdAt: "original" });
  expect(await queueDemo(settings, first, deps)).toMatchObject({ revision: "original", createdAt: "original" });
  expect(await deps.read(ACTIVE)).toEqual({ runId: first });
});
it("refuses invalid IDs and fleet sizes before any cloud operation", async () => {
  const { deps, objects } = fixture();
  await expect(queueDemo(settings, "../../wallets", deps)).rejects.toThrow("Invalid");
  await expect(queueDemo({ ...settings, agentCount: 26 }, first, deps)).rejects.toThrow("25");
  expect(objects.size).toBe(0);
});
it("refuses a new run before writing the queue when independent compute authority is halted", async () => {
  const { deps, objects, start } = fixture();
  deps.authoriseNewRun = async () => { throw new Error("Compute allocation is halted"); };
  await expect(queueDemo(settings, first, deps)).rejects.toThrow("halted");
  expect(objects.size).toBe(0);
  expect(start).not.toHaveBeenCalled();
});
