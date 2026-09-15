// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const now = Math.floor(Date.now() / 1000);
const allocation = { allocationId: "test-allocation", runId: "test-run", issuedAt: now - 300,
  approvalDeadline: now + 60, stopAt: now + 600, maxObservationAgeSeconds: 120, requiredProposalIds: ["123"] };
const controller = { phase: "halted", reason: "vote_failed", haltedAt: now - 5, stopRequestedAt: now - 4, observedAt: now - 5 };
const evidence = { allocation, allocationId: allocation.allocationId, proposalId: "123", workflowRun: "12345",
  observedAt: new Date().toISOString(), controller: { ...controller, stoppedAt: now },
  votes: [0, 1, 2, 3, 4].map(agentId => ({ agentId, directive: agentId < 2 ? "FOR" : "AGAINST", reason: { rationale: "<img src=x onerror=alert(1)>" } })) };
async function load(state: unknown) {
  document.documentElement.innerHTML = readFileSync("apps/runner/public/compute.html", "utf8");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: { get: () => "application/json" }, json: async () => state })));
  new Function(readFileSync("apps/runner/public/compute.js", "utf8"))();
  await vi.waitFor(() => expect(document.getElementById("source")?.textContent).toContain("LIVE"));
}
const click = (id: string) => document.getElementById(id)!.click();
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.documentElement.innerHTML = ""; });
describe("compute evidence display", () => {
  it("does not call a stop request a stopped VM; replay never mutates live resources", async () => {
    await load({ allocation, state: controller, vm: { status: "RUNNING" }, observedAt: new Date().toISOString(), evidence });
    expect(document.getElementById("vm-state")?.textContent).toBe("RUNNING");
    click("replay-tab");
    expect(document.getElementById("source")?.textContent).toContain("RECORDED TEST");
    const scrub = document.getElementById("scrub") as HTMLInputElement;
    scrub.value = "4"; scrub.dispatchEvent(new Event("input"));
    expect(document.getElementById("vm-state")?.textContent).toBe("TERMINATED");
    expect(document.querySelectorAll(".ballots img")).toHaveLength(0);
    expect(document.getElementById("ballots")?.textContent).toContain("<img");
    click("live-tab");
    expect(document.getElementById("vm-state")?.textContent).toBe("RUNNING");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/compute-policy", { cache: "no-store" });
  });
  it("shows actual agent tasks and ballots without treating a negative vote as powered-off infrastructure", async () => {
    await load({ allocation, state: { phase: "voting", observedAt: now }, vm: { status: "RUNNING" }, observedAt: new Date().toISOString(), simulation: { runId: "actual" }, simulationStatus: { phase: "voting", scripted: false, agents: [{ agentId: 0, role: "planner", task: "Review the private reference request", phase: "voted", vote: { support: "AGAINST", rationale: "Outside the allowed scope" } }], votes: [{ agentId: 0, directive: "AGAINST", reason: { rationale: "Outside the allowed scope" } }] }, evidence: null });
    (document.querySelector("#agents button") as HTMLButtonElement).click();
    expect(document.getElementById("inspect-content")?.textContent).toContain("Review the private reference request");
    expect(document.getElementById("inspect-content")?.textContent).toContain("Outside the allowed scope");
    expect(document.getElementById("vm-state")?.textContent).toBe("RUNNING");
    expect(document.getElementById("architecture")?.classList.contains("stopped")).toBe(false);
    expect((document.getElementById("run-simulation") as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not show stale controller authority as permission to execute", async () => {
    await load({ allocation, state: { phase: "authorised", observedAt: now - 180 }, vm: { status: "RUNNING" }, observedAt: new Date().toISOString(), evidence: null });
    expect(document.getElementById("state-label")?.textContent).toBe("AUTHORITY STALE");
    expect(document.getElementById("task-badge")?.textContent).toBe("Task work paused");
    expect((document.getElementById("replay-tab") as HTMLButtonElement).disabled).toBe(true);
  });
});
