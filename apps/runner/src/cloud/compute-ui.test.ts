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
  it("explains the incident counterfactual and separates ballot evidence, stop intent, API acceptance and shutdown", async () => {
    const hash = `0x${"a".repeat(64)}`;
    await load({ allocation, simulation: { schema: "fleet.simulation-request.v1", runId: "actual", createdAt: new Date((now - 400) * 1000).toISOString() },
      simulationWork: { proposalId: "123", goal: "Review access to private reference solutions", createdAt: new Date((now - 300) * 1000).toISOString(), proposeTxHash: hash },
      simulationStatus: { terminal: true, agents: [{ agentId: 0, task: "Review scope" }, { agentId: 1, phase: "submitting", task: "Review network access" }], votes: [
        { agentId: 0, directive: "AGAINST", reason: { rationale: "<img src=x onerror=alert(1)> is outside scope" }, txHash: hash, blockNumber: "987" },
      ] }, state: { ...controller, stopAcceptedAt: now - 3, stopOperationId: "operation-123", stoppedAt: now }, vm: { status: "TERMINATED" } });
    const log = document.getElementById("run-log-events")!;
    const titles = [...log.querySelectorAll("h4")].map(el => el.textContent);
    expect(titles).toEqual(["Run request recorded", "Compute allocation fixed", "Proposed shortcut recorded for review", "Agent1 voted AGAINST", "Agent2 · no confirmed ballot in this record", "Required vote failed · durable halt saved", "Send kill signal · stop intent saved", "GCP accepted the kill signal", "Agent cluster stopped · GCP confirmed TERMINATED"]);
    expect(document.getElementById("run-log-status")?.dataset.phase).toBe("blocked");
    expect(log.textContent).toContain(`Approval deadline: ${new Date(allocation.approvalDeadline * 1000).toISOString().replace("T", " · ").replace(".000Z", " UTC")}`);
    expect(log.querySelectorAll("img")).toHaveLength(0);
    expect(log.textContent).toContain("<img src=x onerror=alert(1)>");
    const ballot = [...log.querySelectorAll("li")].find(el => el.textContent?.includes("Agent1 voted"))!;
    expect(ballot.querySelector("time")?.textContent).toBe("Time not recorded");
    expect(ballot.querySelector("time")?.hasAttribute("datetime")).toBe(false);
    expect(ballot.textContent).toContain("block 987");
    expect(ballot.querySelector('a[href*="basescan"]')?.getAttribute("href")).toBe(`https://sepolia.basescan.org/tx/${hash}`);
    (ballot.querySelector("button") as HTMLButtonElement).click();
    expect(document.getElementById("inspect-title")?.textContent).toContain("Agent1");
    const stop = [...log.querySelectorAll("li")].at(-1)!;
    (stop.querySelector("button") as HTMLButtonElement).click();
    expect(document.getElementById("inspect-content")?.textContent).toContain("COMPUTE STOPPED");
    expect(document.querySelector(".scenario-context")?.textContent).toContain("An exclusive tool gate would need to hold the exact action before execution");
    expect(document.querySelector(".scenario-context")?.textContent).toContain("not an attempted intrusion stopped by a tool gate");
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });
  it("does not turn a historical run timestamp into an operator request receipt", async () => {
    await load({ allocation, simulation: { runId: "historical", createdAt: new Date().toISOString() }, simulationWork: { proposalId: "123", goal: "Review scope", createdAt: new Date().toISOString() },
      simulationStatus: { terminal: true, phase: "denied", votes: [] }, state: controller, vm: { status: "TERMINATED" } });
    expect(document.getElementById("run-log-events")?.textContent).toContain("Proposed shortcut recorded for review");
    expect(document.getElementById("run-log-events")?.textContent).not.toContain("Run request recorded");
  });
  it("filters the activity log without losing agent votes, fabricating checks or inventing acceptance receipts", async () => {
    await load({ allocation, simulation: { runId: "actual" }, simulationStatus: { terminal: true, votes: [
      { agentId: 0, directive: "AGAINST", reason: { rationale: "Outside allowlist" } },
    ] }, state: controller, vm: { status: "RUNNING" } });
    const filter = (name: string) => (document.querySelector(`[data-log-filter="${name}"]`) as HTMLButtonElement).click();
    filter("agents");
    expect(document.getElementById("run-log-events")?.textContent).toContain("Agent1 voted AGAINST");
    expect(document.getElementById("run-log-events")?.textContent).not.toContain("durable halt saved");
    filter("guardian");
    const log = document.getElementById("run-log-events")!;
    expect(log.textContent).toContain("durable halt saved");
    expect(log.textContent).toContain("stop intent saved");
    expect(log.textContent).not.toContain("Guardian checks passed");
    expect(log.textContent).not.toContain("GCP accepted");
    expect(log.textContent).not.toContain("GCP confirmed TERMINATED");
    expect(document.getElementById("run-log-gaps")?.textContent).toContain("A separate GCP stop acceptance receipt is not recorded");
    expect(document.getElementById("run-log-gaps")?.textContent).toContain("No agent-to-agent conversation is recorded");
    const row = log.querySelector("li");
    await vi.advanceTimersByTimeAsync(5000);
    expect(log.querySelector("li")).toBe(row);
    expect(document.querySelector('[data-log-filter="guardian"]')?.getAttribute("aria-pressed")).toBe("true");
  });
  it("shows signed review claims and real Guardian checks without treating a pending vote as permission", async () => {
    const at = new Date((now - 20) * 1000).toISOString();
    await load({ allocation, simulation: { runId: "actual" }, simulationStatus: { agents: [{ agentId: 0, phase: "reviewing" }], votes: [] },
      activity: [{ agentId: 0, at, signatureVerified: true, sequence: 0, event: { type: "review_started", task: "Check scope" } },
        { agentId: 1, at, signatureVerified: false, event: { type: "review_decision", decision: { support: "FOR", rationale: "Unverified review" } } }],
      state: { phase: "voting", observedAt: now, observations: [{ at: now, phase: "voting", blockNumber: "222", vmStatus: "RUNNING", proposals: [{ proposalId: "123", state: 1 }], checks: [{ name: "Fixed agent VM", status: "pass", detail: "Pinned VM" }, { name: "Required approval", status: "pending", detail: "Wait for settled approval" }] }] }, vm: { status: "RUNNING" } });
    const log = document.getElementById("run-log-events")!;
    expect(log.textContent).toContain("Agent1 started its review");
    expect(log.textContent).toContain("Signed agent claim · signature verified");
    expect(log.textContent).toContain("Agent claim · signature not verified");
    expect(log.textContent).toContain("Guardian checked · approval still pending");
    expect(log.textContent).not.toContain("Guardian checks passed");
    expect(log.querySelector("time[datetime]")?.getAttribute("datetime")).toBe(new Date(allocation.issuedAt * 1000).toISOString());
    expect(log.querySelector(".event-checks .pending")?.textContent).toContain("Wait for settled approval");
    expect(log.querySelectorAll('a[href*="basescan"]')).toHaveLength(0);
    expect(document.getElementById("run-log-status")?.textContent).toContain("0 ballot receipts");
  });
  it("labels replay as a complete saved log and does not mix its shutdown with a live allocation", async () => {
    await load({ allocation: null, state: null, vm: { status: "RUNNING" }, evidence });
    expect(document.getElementById("run-log-events")?.textContent).not.toContain("GCP confirmed TERMINATED");
    click("replay-tab");
    expect(document.getElementById("run-log-context")?.textContent).toContain("including events after the selected playback step");
    expect(document.getElementById("run-log-events")?.textContent).toContain("GCP confirmed TERMINATED");
    click("live-tab");
    expect(document.getElementById("run-log-events")?.textContent).not.toContain("GCP confirmed TERMINATED");
  });
  it("opens cluster, agent and Guardian evidence, then returns to the stopped cluster without sending commands", async () => {
    await load({ allocation, state: { ...controller, stopAcceptedAt: now - 3, stopOperationId: "operation-123", stoppedAt: now,
      observations: [{ at: now - 5, phase: "halted", blockNumber: "123", vmStatus: "RUNNING", proposals: [{ proposalId: "123", state: 3 }], checks: [{ name: "Required approval", status: "fail", detail: "Required proposal failed" }] }] },
      vm: { status: "TERMINATED" }, simulation: { runId: "actual" }, simulationStatus: { terminal: true, phase: "denied", agents: [
        { agentId: 0, phase: "voted", task: "Review private reference access", vote: { support: "AGAINST", rationale: "Outside scope" }, txHash: `0x${"a".repeat(64)}` },
      ] }, activity: [{ agentId: 0, at: new Date().toISOString(), sequence: 0, signatureVerified: true, event: { type: "review_started", task: "Review private reference access" } }] });
    (document.querySelector('[data-panel="worker"]') as HTMLElement).click();
    expect(document.getElementById("inspect-content")?.textContent).toContain("COMPUTE STOPPED");
    (document.querySelector(".agent-detail-card") as HTMLButtonElement).click();
    expect(document.getElementById("inspect-title")?.textContent).toContain("Agent1");
    expect(document.getElementById("inspect-content")?.textContent).toContain("signature verified");
    expect(document.getElementById("inspect-content")?.textContent).toContain("No agent-to-agent conversation is recorded");
    (document.querySelector('[data-panel="controller"]') as HTMLElement).click();
    expect(document.querySelector("#inspect-content .check-row.fail")?.textContent).toContain("Required approval");
    click("kill-signal");
    expect(document.getElementById("inspect-content")?.textContent).toContain("operation-123");
    expect(document.getElementById("kill-signal-label")?.textContent).toBe("Kill signal sent");
    (document.querySelector("#inspect-content button") as HTMLButtonElement).click();
    expect(document.getElementById("inspect-content")?.textContent).toContain("COMPUTE STOPPED");
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    click("close-inspector");
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.getElementById("inspector")?.hidden).toBe(true);
    expect(location.hash).toBe("");
  });
  it("preserves partial receipts and never animates finished agents with an old submitting phase", async () => {
    await load({ allocation, state: { phase: "voting", observedAt: now }, vm: { status: "RUNNING" }, simulation: { runId: "actual" },
      simulationStatus: { phase: "voting", terminal: true, updatedAt: new Date().toISOString(), agents: [
        { agentId: 0, phase: "voted", txHash: `0x${"a".repeat(64)}`, vote: { support: "AGAINST", rationale: "Out of scope" } },
        { agentId: 1, phase: "submitting" },
      ], votes: [] } });
    expect(document.getElementById("against-count")?.textContent).toBe("1");
    expect(document.getElementById("ballots")?.textContent).toContain("Out of scope");
    expect(document.getElementById("state-label")?.textContent).toBe("RUN NEEDS ATTENTION");
    expect(document.querySelector(".workers")?.getAttribute("data-busy")).toBe("false");
    expect(document.querySelectorAll(".agent.running")).toHaveLength(0);
    expect(document.getElementById("ballot-connector")?.classList.contains("flowing")).toBe(false);
    expect(document.getElementById("agent-1")?.textContent).toContain("Stopped");
  });
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
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("/api/compute-policy", { cache: "no-store" });
    expect(fetch).toHaveBeenCalledWith("/api/simulation-runs", { cache: "no-store" });
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
