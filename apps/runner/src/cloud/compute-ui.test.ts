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
  it("shows preparation work without pretending the queued agents are reviewing", async () => {
    await load({ allocation: null, state: null, vm: { status: "RUNNING" }, simulation: { runId: "actual" },
      simulationStatus: { phase: "provisioning", updatedAt: new Date().toISOString(), agents: [] } });
    expect(document.querySelector(".workers")?.getAttribute("data-phase")).toBe("working");
    expect(document.querySelector(".workers")?.getAttribute("data-busy")).toBe("true");
    expect(document.getElementById("worker-activity-title")?.textContent).toBe("Preparing the worker");
    expect(document.querySelectorAll(".agent.running")).toHaveLength(0);
    expect(document.querySelectorAll(".agent.idle")).toHaveLength(5);
    expect(document.querySelectorAll(".connector.flowing")).toHaveLength(0);
    expect(document.getElementById("guardian-activity-title")?.textContent).toBe("Standing by");
  });
  it("shows concurrent reviews, signatures and confirmed ballots, then stops work animation on a halt", async () => {
    const state = { allocation, state: { phase: "voting", observedAt: now }, vm: { status: "RUNNING" }, simulation: { runId: "actual" },
      simulationStatus: { phase: "voting", updatedAt: new Date().toISOString(), agents: [
        { agentId: 0, phase: "reviewing" }, { agentId: 1, phase: "submitting" },
        { agentId: 2, phase: "voted", vote: { support: "AGAINST" } },
      ], votes: [] } };
    await load(state);
    expect(document.getElementById("worker-activity-title")?.textContent).toBe("1 reviewing · 1 signing");
    expect(document.getElementById("chain-activity-detail")?.textContent).toBe("1 / 5 confirmed on Base Sepolia");
    expect(document.querySelectorAll(".agent.running")).toHaveLength(2);
    expect(document.querySelectorAll(".connector.flowing")).toHaveLength(2);
    expect(document.getElementById("agent-2")?.classList.contains("blocked")).toBe(true);
    expect(document.querySelector(".workers")?.getAttribute("data-phase")).toBe("working");
    const agent = document.getElementById("agent-0");
    Object.assign(state.state, controller);
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.getElementById("agent-0")).toBe(agent);
    expect(document.querySelectorAll(".agent.running")).toHaveLength(0);
    expect(document.querySelectorAll(".connector.flowing")).toHaveLength(0);
    expect(document.getElementById("guardian-activity-title")?.textContent).toBe("Stopping the worker");
    expect(document.getElementById("worker-activity-title")?.textContent).toBe("Task execution blocked");
  });
  it("marks missing progress as waiting and freezes activity when observation fails", async () => {
    await load({ allocation: null, state: null, vm: { status: "RUNNING" }, simulation: { runId: "actual" },
      simulationStatus: { phase: "provisioning", updatedAt: new Date(Date.now() - 180000).toISOString(), agents: [] } });
    expect(document.getElementById("worker-activity-title")?.textContent).toBe("Waiting for a progress update");
    expect(document.querySelector(".workers")?.getAttribute("data-busy")).toBe("false");
    expect(document.getElementById("activity-age")?.textContent).toContain("3m ago");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Connection unavailable"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.getElementById("architecture-map")?.dataset.observation).toBe("unavailable");
    expect(document.getElementById("activity-summary")?.dataset.busy).toBe("false");
    expect(document.getElementById("activity-title")?.textContent).toBe("Waiting for a fresh observation");
  });
  it("does not call a stop request a stopped VM; replay never mutates live resources", async () => {
    await load({ allocation, state: controller, vm: { status: "RUNNING" }, observedAt: new Date().toISOString(), evidence });
    expect(document.getElementById("vm-state")?.textContent).toBe("RUNNING");
    expect(document.getElementById("architecture-map")?.dataset.shutdown).toBe("stopping");
    click("replay-tab");
    expect(document.getElementById("source")?.textContent).toContain("RECORDED TEST");
    const scrub = document.getElementById("scrub") as HTMLInputElement;
    scrub.value = "2"; scrub.dispatchEvent(new Event("input"));
    expect(document.getElementById("architecture-map")?.dataset.shutdown).toBe("blocked");
    expect(document.getElementById("controller-command")?.textContent).toContain("stop pending");
    scrub.value = "3"; scrub.dispatchEvent(new Event("input"));
    expect(document.getElementById("architecture-map")?.dataset.shutdown).toBe("stopping");
    expect(document.getElementById("vm-state")?.textContent).toBe("STOP REQUESTED");
    scrub.value = "4"; scrub.dispatchEvent(new Event("input"));
    expect(document.getElementById("architecture-map")?.dataset.shutdown).toBe("off");
    click("shutdown-link");
    expect(document.getElementById("inspect-title")?.textContent).toBe("The Guardian closes the loop");
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
    expect(document.querySelector("#agents button")?.classList.contains("blocked")).toBe(true);
    expect(document.getElementById("architecture-map")?.dataset.shutdown).toBe("idle");
    expect(document.querySelector(".workers")?.getAttribute("data-phase")).toBe("idle");
    expect((document.getElementById("run-simulation") as HTMLButtonElement).disabled).toBe(true);
  });
  it("does not show stale controller authority as permission to execute", async () => {
    await load({ allocation, state: { phase: "authorised", observedAt: now - 180 }, vm: { status: "RUNNING" }, observedAt: new Date().toISOString(), evidence: null });
    expect(document.getElementById("state-label")?.textContent).toBe("AUTHORITY STALE");
    expect(document.getElementById("task-badge")?.textContent).toBe("Task work paused");
    expect((document.getElementById("replay-tab") as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps recorded shutdown inspections separate from a recovered live worker", async () => {
    await load({ allocation: null, state: null, vm: { status: "RUNNING" }, observedAt: new Date().toISOString(), evidence: {
      ...evidence, vm: { status: "TERMINATED" }, inference: { budget: { chargedCostUsd: 0.004 } },
    } });
    expect(document.getElementById("model-spend")?.textContent).toBe("No current model run");
    click("replay-tab");
    (document.querySelector('[data-inspect="worker"]') as HTMLButtonElement).click();
    expect(document.getElementById("inspect-content")?.textContent).toContain("Recorded final instance");
    expect(document.getElementById("inspect-content")?.textContent).toContain("TERMINATED");
    (document.querySelector('[data-inspect="controller"]') as HTMLButtonElement).click();
    expect(document.getElementById("inspect-content")?.textContent).toContain("vote_failed");
    click("live-tab");
    expect(document.getElementById("inspect-content")?.textContent).toContain("No Guardian record yet");
    expect(document.getElementById("architecture-map")?.dataset.shutdown).toBe("idle");
  });
});
