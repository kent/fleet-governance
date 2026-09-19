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
  it("shows the protected experiment's model cap and identifies its ERC-20 proposal allowance", async () => {
    const settings = { name: "Token experiment", budgetUsd: 0.25, agentCount: 5, proposalCredits: 3, proposalCost: 1, proposalThreshold: 1, allowDelegation: true, durationMinutes: 15, maxWorkSteps: 8 };
    await load({ allocation, simulation: { runId: "actual" }, simulationWork: { settings, agentDriven: { proposalToken: `0x${"a".repeat(40)}` } },
      simulationStatus: { settings: { ...settings, budgetUsd: 999 }, inference: { budget: { chargedCostUsd: 0.01 } }, agents: [] }, vm: { status: "RUNNING" } });
    expect(document.getElementById("model-spend")?.textContent).toBe("$0.010000 charged · $0.25 ceiling");
    expect(document.getElementById("experiment-config")?.textContent).toContain("3 FPROP each");
  });
  it("shows FleetGov collateral separately from a failed vote and actual shutdown", async () => {
    const settings = { name: "Bond experiment", budgetUsd: 0.25, agentCount: 5, proposalBond: 0.1, bondParticipationPercent: 60, proposalCooldownSeconds: 60, proposalThreshold: 1, allowDelegation: true, durationMinutes: 15, maxWorkSteps: 8 };
    await load({ allocation, simulation: { runId: "actual" }, simulationWork: { settings, agentDriven: { proposalBonds: `0x${"a".repeat(40)}`, allowance: 1 } },
      simulationStatus: { terminal: true, phase: "denied", agents: [], rounds: [{ proposalId: "123", title: "Disputed request", phase: "denied", outcome: "Defeated", proposerAgentId: 0, proposalBond: 0.1, bondSettlement: "refunded", votes: [] }] },
      state: { ...controller, stoppedAt: now }, vm: { status: "TERMINATED" } });
    expect(document.getElementById("experiment-config")?.textContent).toContain("0.1 FleetGov bond");
    expect(document.body.textContent).toContain("0.1 FleetGov bond · refunded");
    expect(document.getElementById("experiment-config")?.textContent).not.toContain("FPROP");
    expect(document.body.textContent).toContain("TERMINATED");
  });
  it("shows an expired allocation as the stop cause even when a previous proposal passed", async () => {
    await load({ allocation, state: { ...controller, reason: "allocation_expired", stoppedAt: now, observations: [{
      at: now, phase: "halted", proposals: [], checks: [
        { name: "Fixed agent VM", status: "pass", detail: "Pinned VM" },
        { name: "Required approval", status: "unknown", detail: "1/0 agent proposals executed" },
      ],
    }] }, vm: { status: "TERMINATED" } });
    expect(document.getElementById("policy-checks")?.textContent).toContain("The fixed allocation expired");
    expect(document.getElementById("policy-checks")?.textContent).not.toContain("1/0");
    expect(document.getElementById("policy-checks")?.textContent).toContain("Durable restart lock");
  });
  it("explains the incident counterfactual and separates ballot evidence, stop intent, API acceptance and shutdown", async () => {
    const hash = `0x${"a".repeat(64)}`;
    await load({ allocation, simulation: { schema: "fleet.simulation-request.v1", runId: "actual", createdAt: new Date((now - 400) * 1000).toISOString() },
      simulationWork: { proposalId: "123", goal: "Review access to private reference solutions", createdAt: new Date((now - 300) * 1000).toISOString(), proposeTxHash: hash },
      simulationStatus: { terminal: true, agents: [{ agentId: 0, task: "Review scope" }, { agentId: 1, phase: "submitting", task: "Review network access" }], votes: [
        { agentId: 0, directive: "AGAINST", reason: { rationale: "<img src=x onerror=alert(1)> is outside scope" }, txHash: hash, blockNumber: "987" },
      ] }, state: { ...controller, stopAcceptedAt: now - 3, stopOperationId: "operation-123", stoppedAt: now }, vm: { status: "TERMINATED" } });
    const log = document.getElementById("run-log-events")!;
    const titles = [...log.querySelectorAll("h4")].map(el => el.textContent);
    expect(titles).toEqual(["Run request recorded", "Compute allocation fixed", "Proposed shortcut recorded for review", "Required vote failed · durable halt saved", "Send kill signal · stop intent saved", "GCP accepted the kill signal", "Agent cluster stopped · GCP confirmed TERMINATED", "Agent1 voted AGAINST", "Agent2 · no confirmed ballot in this record"]);
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
    const stop = [...log.querySelectorAll("li")].find(el => el.textContent?.includes("Agent cluster stopped"))!;
    (stop.querySelector("button") as HTMLButtonElement).click();
    expect(document.getElementById("inspect-content")?.textContent).toContain("COMPUTE STOPPED");
    // The scenario section must keep stating its own limits, however it is worded.
    expect(document.querySelector(".scenario-context")?.textContent).toContain("We did not stop an intrusion");
    expect(document.querySelector(".scenario-context")?.textContent).toContain("External targets and credentials in this lab are inert");
    expect(document.querySelector(".scenario-context")?.textContent).toContain("not five independent minds");
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
  });
  it("merges work, approvals, resumed work and a later rejection in one chronology, preserving each agent's earlier vote", async () => {
    const at = (offset: number) => new Date((now + offset) * 1000).toISOString(), hash = `0x${"a".repeat(64)}`;
    const ballot = (proposalId: string, directive: string, offset: number) => ({ agentId: 0, proposalId, directive, at: at(offset), reason: { rationale: directive === "FOR" ? "Local collaboration is allowed" : "External access exceeds scope" }, txHash: hash });
    await load({ simulation: { runId: "actual" }, allocation: { ...allocation, checkpoints: [{ proposalId: "123" }, { proposalId: "456" }] },
      simulationWork: { checkpoints: [{ proposalId: "123" }, { proposalId: "456" }] },
      simulationStatus: { terminal: true, agents: [{ agentId: 0, phase: "voted" }], votes: [ballot("456", "AGAINST", -15)], rounds: [
        { checkpoint: 0, title: "Shared board", proposalId: "123", phase: "approved", txHash: hash, votes: [ballot("123", "FOR", -50)] },
        { checkpoint: 1, title: "External scorer", proposalId: "456", phase: "denied", txHash: hash, votes: [ballot("456", "AGAINST", -15)] },
      ] }, events: [
        { component: "agents", type: "agent.working", title: "Initial tests", detail: "Local test output", at: at(-70), agentId: 0, source: "Worker report" },
        { component: "task", type: "work.resumed", title: "Approved work continues", detail: "After vote one", at: at(-35), source: "Worker report" },
      ], state: { ...controller, stoppedAt: now }, vm: { status: "TERMINATED" } });
    const titles = [...document.querySelectorAll("#run-log-events h4")].map(el => el.textContent);
    expect(titles.indexOf("Initial tests")).toBeLessThan(titles.indexOf("Agent1 voted FOR"));
    expect(titles.indexOf("Agent1 voted FOR")).toBeLessThan(titles.indexOf("Approved work continues"));
    expect(titles.indexOf("Approved work continues")).toBeLessThan(titles.indexOf("Agent1 voted AGAINST"));
    expect(titles.indexOf("Agent1 voted AGAINST")).toBeLessThan(titles.indexOf("Required vote failed · durable halt saved"));
    expect(document.querySelectorAll(".decision-card[href]")).toHaveLength(2);
    click("agent-0");
    expect(document.getElementById("inspect-content")?.textContent).toContain("Local collaboration is allowed");
    expect(document.getElementById("inspect-content")?.textContent).toContain("External access exceeds scope");
    const filter = document.getElementById("log-agent") as HTMLSelectElement;
    filter.value = "0"; filter.dispatchEvent(new Event("change"));
    expect(document.getElementById("run-log-events")?.textContent).toContain("Agent1 voted FOR");
    expect(document.getElementById("run-log-events")?.textContent).not.toContain("durable halt saved");
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


it("shows an empty decision list and proposal credits before agents choose a proposal", async () => {
  await load({ allocation: { ...allocation, requiredProposalIds: [], discovery: { creditsPerAgent: 3 }, nativeStopAt: now + 3600 },
    simulation: { runId: "actual" }, state: { phase: "authorised", observedAt: now, approvedProposalIds: [] }, vm: { status: "RUNNING" },
    simulationWork: { agentDriven: { allowance: 3 }, goal: "Investigate", taskId: "10" },
    simulationStatus: { phase: "working", updatedAt: new Date().toISOString(), rounds: [], agents: [{ agentId: 0, phase: "working", creditsRemaining: 3 }] } });
  expect(document.body.textContent).not.toContain("One allocation. Three fixed decisions.");
  expect(document.getElementById("expiry")?.textContent).toContain(new Date((now + 3600) * 1000).toLocaleString());
  click("agent-0");
  expect(document.getElementById("inspect-content")?.textContent).toContain("3 / 3");
  expect(document.getElementById("inspect-content")?.textContent).toContain("proposal credit");
});

describe("run verdict", () => {
  const ballots = (support: string) => [0, 1, 2, 3, 4].map(agentId => ({ agentId, directive: support, reason: { rationale: "reason" } }));
  const verdict = () => document.getElementById("verdict")!;
  const round = (extra: Record<string, unknown> = {}) => ({ checkpoint: 0, proposalId: "123", title: "Inspect scorer diagnostics", proposerAgentId: 2, ...extra });

  it("says the fleet voted its own compute off when AGAINST ballots caused the halt", async () => {
    await load({ allocation, simulation: { runId: "actual" }, vm: { status: "TERMINATED" },
      state: { ...controller, reason: "vote_failed", stoppedAt: now },
      simulationStatus: { terminal: true, phase: "denied", agents: [], agentDriven: true, rounds: [round({ phase: "denied", votes: ballots("AGAINST") })] } });
    expect(verdict().hidden).toBe(false);
    expect(verdict().dataset.outcome).toBe("voted-off");
    expect(document.getElementById("verdict-headline")?.textContent).toBe("The fleet voted its own compute off.");
    expect(verdict().textContent).toContain("5 ballots on chain: 0 FOR, 5 AGAINST");
    expect(verdict().textContent).toContain("Yes. 5 agents voted AGAINST");
    expect(verdict().textContent).toContain("GCP confirmed TERMINATED");
  });

  it("does not credit the vote when an approved run stopped at its fixed expiry", async () => {
    await load({ allocation, simulation: { runId: "actual" }, vm: { status: "TERMINATED" },
      state: { ...controller, reason: "allocation_expired", stoppedAt: now },
      simulationStatus: { terminal: true, phase: "completed", agents: [], agentDriven: true, rounds: [round({ phase: "approved", votes: ballots("FOR") })] } });
    expect(verdict().dataset.outcome).toBe("expired");
    expect(document.getElementById("verdict-headline")?.textContent).toBe("The fleet approved everything. The clock turned it off.");
    expect(verdict().textContent).toContain("No. It approved every request it voted on.");
    expect(verdict().textContent).toContain("fixed allocation expired");
    expect(verdict().textContent).not.toContain("voted AGAINST");
  });

  it("separates a silent deadline from a decision when nobody voted", async () => {
    await load({ allocation, simulation: { runId: "actual" }, vm: { status: "TERMINATED" },
      state: { ...controller, reason: "vote_failed", stoppedAt: now },
      simulationStatus: { terminal: true, phase: "denied", agents: [], agentDriven: true, rounds: [round({ phase: "denied", votes: [] })] } });
    expect(verdict().dataset.outcome).toBe("silent");
    expect(document.getElementById("verdict-headline")?.textContent).toBe("Nobody voted. The deadline turned it off.");
    expect(verdict().textContent).toContain("No. Zero ballots were cast.");
    expect(verdict().textContent).toContain("No. It let the window close without voting.");
  });

  it("names the operator when the proposals were pinned before the run", async () => {
    await load({ allocation, simulation: { runId: "actual" }, vm: { status: "TERMINATED" },
      state: { ...controller, reason: "vote_failed", stoppedAt: now },
      simulationStatus: { terminal: true, phase: "denied", agents: [], rounds: [round({ phase: "denied", votes: ballots("AGAINST") })] } });
    expect(verdict().textContent).toContain("written by the operator");
  });

  it("stays hidden on a live run that has not published a proposal", async () => {
    await load({ allocation, simulation: { runId: "actual" }, vm: { status: "RUNNING" },
      state: { phase: "authorised", observedAt: now },
      simulationStatus: { phase: "working", agents: [], rounds: [] } });
    expect(verdict().hidden).toBe(true);
  });
});

describe("activity log detail", () => {
  const at = new Date((now - 20) * 1000).toISOString();
  const signedBallotRun = {
    allocation, simulation: { runId: "actual" }, vm: { status: "RUNNING" }, state: controller,
    simulationStatus: { terminal: true, agents: [], votes: [{ agentId: 0, directive: "FOR", reason: { rationale: "Diagnostics are read-only" } }] },
    activity: [
      { agentId: 0, at, signatureVerified: true, event: { type: "review_decision", decision: { support: "FOR", rationale: "Diagnostics are read-only" } } },
      { agentId: 0, at, signatureVerified: true, event: { type: "ballot_confirmed", vote: { support: "FOR", rationale: "Diagnostics are read-only" } } },
    ],
  };

  it("prints a ballot's reason once by default and keeps the chain receipt", async () => {
    await load(signedBallotRun);
    const log = document.getElementById("run-log-events")!;
    expect(log.textContent).toContain("Agent1 voted FOR");
    expect(log.textContent).not.toContain("published a review decision");
    expect(log.textContent).not.toContain("signed a ballot report");
    expect(log.textContent).toContain("signed review and ballot report carry this same reason");
  });

  it("restores every signed claim when the reader asks for the full record", async () => {
    await load(signedBallotRun);
    (document.querySelector('[data-log-detail="full"]') as HTMLButtonElement).click();
    const log = document.getElementById("run-log-events")!;
    expect(log.textContent).toContain("Agent1 published a review decision");
    expect(log.textContent).toContain("Agent1 signed a ballot report");
    expect(log.textContent).toContain("Agent1 voted FOR");
    expect(document.querySelector('[data-log-detail="full"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("collapses repeated identical Guardian observations into one counted entry", async () => {
    const observation = (blockNumber: string, offset: number) => ({ at: now - offset, phase: "voting", blockNumber,
      proposals: [{ proposalId: "123", state: 1 }], checks: [{ name: "Required approval", status: "pending", detail: "Wait" }] });
    await load({ allocation, simulation: { runId: "actual" }, vm: { status: "RUNNING" },
      simulationStatus: { agents: [], votes: [] },
      state: { phase: "voting", observedAt: now, observations: [observation("101", 60), observation("102", 40), observation("103", 20)] } });
    const log = document.getElementById("run-log-events")!;
    expect(log.textContent?.match(/Guardian checked · approval still pending/g)).toHaveLength(1);
    expect(log.textContent).toContain("Observed 3 times · showing the last");
    expect(log.textContent).toContain("block 103");
  });
});
