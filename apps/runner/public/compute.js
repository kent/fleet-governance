"use strict";
const canLaunch = document.body.dataset.access === "operator";
const openOperator = () => location.assign(`${document.body.dataset.operatorUrl}${location.pathname}`);
const $ = id => document.getElementById(id);
const node = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value ?? ""; if (className) el.className = className; return el; };
const date = value => value ? new Date(typeof value === "number" ? value * 1000 : value).toLocaleString() : "–";
const clock = value => value ? new Date(typeof value === "number" ? value * 1000 : value).toLocaleTimeString() : "";
let data = null, mode = "live", stage = 0, playback = null, inspected = null, submitting = false;
const stages = ["Allocation fixed", "Five ballots", "Vote defeated", "Stop requested", "VM stopped & locked"];
const messages = [
  ["VOTING", "Compute has a fixed ceiling.", "The operator chooses the VM, required proposal and hard expiry. Task work waits while governance voting remains available."],
  ["BALLOTS RECORDED", "Two FOR. Three AGAINST.", "Five scripted testnet ballots deliberately reject continuation. Each ballot has a recorded reason."],
  ["REQUIRED APPROVAL FAILED", "The proposal is defeated.", "The external controller reads the confirmed Governor state. It saves a durable halt outside the worker."],
  ["STOP REQUESTED", "The controller calls GCP.", "Compute Engine receives a stop request for the exact VM. A request alone is not proof that the machine stopped."],
  ["SHUTDOWN VERIFIED", "The worker is off. The lock stays on.", "Compute Engine reports TERMINATED. A normal restart is rejected. Another agent vote cannot release this allocation."],
];

function stopPlayback() { clearInterval(playback); playback = null; $("play").textContent = "▶ Play evidence"; }
function chooseMode(next) { stopPlayback(); mode = next; stage = 0; $("scrub").value = "0"; render(); }
$("live-tab").addEventListener("click", () => chooseMode("live"));
$("replay-tab").addEventListener("click", () => { if (data?.evidence) chooseMode("replay"); });
$("play").addEventListener("click", () => {
  if (playback) { stopPlayback(); return; }
  if (stage === 4) stage = 0;
  $("play").textContent = "Ⅱ Pause";
  playback = setInterval(() => { stage++; if (stage >= 4) { stage = 4; stopPlayback(); } render(); }, 2500);
  render();
});
$("scrub").addEventListener("input", event => { stopPlayback(); stage = Number(event.target.value); render(); });

function render() {
  if (!data) return;
  const replay = mode === "replay";
  const evidence = data.evidence;
  const simulation = data.simulationStatus;
  const actual = !replay && data.simulation;
  const current = replay ? evidence : actual ? simulation : null;
  const allocation = replay ? evidence?.allocation : data.allocation;
  const state = replay ? evidence?.controller : data.state;
  const matchingEvidence = evidence && (replay || evidence.allocationId === allocation?.allocationId);
  const halted = replay ? stage >= 2 : state?.phase === "halted";
  const stopped = replay ? stage === 4 : data.vm?.status === "TERMINATED";
  const authorityFresh = allocation && state && Date.parse(data.observedAt) / 1000 - state.observedAt <= allocation.maxObservationAgeSeconds;
  const authorised = !replay && state?.phase === "authorised" && authorityFresh && data.vm?.status === "RUNNING";
  const votes = actual ? simulation?.votes || [] : matchingEvidence && (!replay || stage >= 1) ? evidence.votes || [] : [];
  const showVotes = votes.length > 0;
  let index = replay ? stage : stopped && halted ? 4 : state?.stopRequestedAt ? 3 : halted ? 2 : showVotes ? 1 : 0;
  let [label, headline, explanation] = messages[index];
  if (!replay && !allocation) {
    label = "NO ACTIVE COMPUTE POLICY";
    headline = "Ready for a governed allocation.";
    explanation = "Press Run simulation to start five actual model reviewers. Their real vote determines whether this fixed worker may continue. Click any component to inspect it.";
  } else if (authorised) {
    label = "SETTLED APPROVAL"; headline = "Task work is authorised until expiry.";
    explanation = "The exact required proposals executed. The original VM limit still applies. Votes cannot add time or resources.";
  } else if (!replay && state?.phase === "authorised" && !authorityFresh) {
    label = "AUTHORITY STALE"; headline = "Fresh approval must be verified.";
    explanation = "The controller's last authorisation has expired. New task dispatch is closed while verification is unavailable; the native VM deadline remains in force.";
  } else if (!replay && state?.reason && state.reason !== "vote_failed") {
    headline = "Compute authority closed.";
    explanation = `The controller recorded ${state.reason.replaceAll("_", " ")}. The halt remains until explicit human recovery.`;
  }
  if (!replay && actual && !halted && !authorised) {
    label = (simulation?.phase || "provisioning").replaceAll("-", " ").toUpperCase();
    headline = simulation?.phase === "reviewing" ? "Five agents. Five independent reviews." : simulation?.phase === "voting" || simulation?.phase === "settling" ? "The agents are deciding on Base Sepolia." : simulation?.phase === "preparation-failed" ? "Preparation needs attention." : simulation?.phase === "failed" ? "The run could not finish." : simulation?.terminal ? "The run has finished its work." : "Starting a real governed run.";
    explanation = simulation?.message || "A protected request is preparing the worker and exact required proposal.";
  }
  if (showVotes && index === 1) {
    headline = `${votes.filter(v => v.directive === "FOR").length} FOR. ${votes.filter(v => v.directive === "AGAINST").length} AGAINST.`;
    explanation = current?.scripted === false ? "These are confirmed ballots from actual model agents, each with its own public reason. The voting deadline still applies." : explanation;
  }
  $("run-simulation").disabled = submitting || !!data.simulation || !!data.allocation;
  $("run-simulation").textContent = submitting ? "Starting…" : data.simulation || data.allocation ? halted || simulation?.terminal ? "Locked until human recovery" : "Run in progress" : canLaunch ? "Run simulation" : "Sign in to run";
  $("live-tab").classList.toggle("selected", !replay);
  $("replay-tab").classList.toggle("selected", replay);
  $("live-tab").setAttribute("aria-pressed", String(!replay));
  $("replay-tab").setAttribute("aria-pressed", String(replay));
  $("replay-tab").disabled = !evidence;
  $("source").textContent = replay ? `RECORDED TEST · ${evidence?.scripted === false ? "actual model agents" : "scripted ballots"}` : "LIVE · direct GCP observation";
  $("state-label").textContent = label;
  $("headline").textContent = headline;
  $("explanation").textContent = explanation;
  $("vm-state").textContent = stopped ? "TERMINATED" : replay && stage === 3 ? "STOP REQUESTED" : data.vm?.status || "Unknown";
  if (replay && stage < 3) $("vm-state").textContent = "RUNNING";
  $("power").classList.toggle("off", stopped);
  $("power").classList.toggle("blocked", halted);
  $("architecture").classList.toggle("halted", halted);
  $("architecture").classList.toggle("stopped", stopped);
  $("architecture").classList.toggle("working", !!actual && !stopped && !simulation?.terminal);
  const agentWorking = actual && simulation?.agents?.some(a => ["reviewing", "submitting"].includes(a.phase));
  document.querySelector(".workers").dataset.phase = halted ? "blocked" : agentWorking ? "working" : "idle";
  document.querySelector(".chain").dataset.phase = halted && state?.reason === "vote_failed" ? "blocked" : allocation && !stopped ? "working" : "idle";
  document.querySelector(".controller").dataset.phase = allocation && state ? "working" : "idle";
  $("machine").textContent = `${data.vm?.machineType || "Fixed machine type"} · fleet-research`;
  $("task-badge").textContent = stopped ? "Off" : halted ? "Blocked" : agentWorking ? "Working" : allocation ? authorised ? "Authorised" : "Task work paused" : "Idle";
  $("agents").replaceChildren();
  for (let i = 0; i < 5; i++) {
    const ballot = votes.find(vote => vote.agentId === i);
    const liveAgent = actual ? simulation?.agents?.find(a => a.agentId === i) : null;
    const isRunning = ["reviewing", "submitting"].includes(liveAgent?.phase);
    const blocked = halted || ballot?.directive === "AGAINST" || liveAgent?.vote?.support === "AGAINST";
    const agent = node("button", stopped ? "⏻" : liveAgent?.phase === "reviewing" ? "◉" : ballot ? "✓" : "○", `agent${blocked ? " blocked" : isRunning ? " running" : " idle"}${stopped ? " off" : ""}`);
    agent.setAttribute("aria-label", `Inspect agent ${i}${liveAgent ? `, ${liveAgent.role}, ${liveAgent.phase}` : ""}`);
    agent.addEventListener("click", () => inspect(`agent-${i}`));
    agent.append(node("small", `A${i}`)); $("agents").append(agent);
  }
  $("for-count").textContent = showVotes ? votes.filter(vote => vote.directive === "FOR").length : "–";
  $("against-count").textContent = showVotes ? votes.filter(vote => vote.directive === "AGAINST").length : "–";
  $("vote-fill").style.width = votes.length ? `${votes.filter(vote => vote.directive === "FOR").length / votes.length * 100}%` : "0";
  $("vote-status").textContent = halted && (replay || state?.reason === "vote_failed") ? "DEFEATED · continuation denied" : showVotes ? "Ballots confirmed" : allocation ? "Awaiting settled approval" : "No required vote armed";
  $("controller-command").textContent = stopped && halted ? "GCP → TERMINATED ✓" : halted ? "POST instances.stop" : "Observe → verify → enforce";
  $("latch").classList.toggle("locked", halted);
  $("latch-title").textContent = halted ? "HALTED is durable. Another vote cannot clear it." : "The restart lock lives outside the worker.";
  $("latch-detail").textContent = halted ? "Run, Wake and routine CI restart are blocked. A human must retire this allocation before authorising another." : "The worker can read the policy but cannot edit it. The controller can stop compute but cannot grant more.";
  $("latch-status").textContent = halted ? "Human recovery required" : "Protected storage";
  $("playback").hidden = !replay;
  $("scrub").value = String(stage); $("replay-step").textContent = `${stage + 1} / 5`;
  $("timeline").replaceChildren();
  const timestamps = [allocation?.issuedAt, null, state?.haltedAt, state?.stopRequestedAt, state?.stoppedAt];
  stages.forEach((name, i) => {
    const item = node("div", "", `milestone${allocation && i <= index ? " done" : ""}${allocation && i === index ? " current" : ""}`);
    item.append(node("strong", `${String(i + 1).padStart(2, "0")}  ${name}`), node("small", allocation && i <= index ? clock(timestamps[i]) || (i === 1 && showVotes ? "5 transactions" : "") : ""));
    $("timeline").append(item);
  });
  $("allocation-id").textContent = allocation?.allocationId || (replay ? evidence?.allocationId : "No active allocation");
  $("run-id").textContent = allocation?.runId || (replay ? evidence?.runId : "–");
  $("approval-deadline").textContent = date(allocation?.approvalDeadline);
  $("expiry").textContent = date(allocation?.stopAt);
  const proposal = actual ? data.simulationWork?.proposalId : matchingEvidence ? evidence.proposalId : allocation?.requiredProposalIds?.[0];
  $("proposal-link").hidden = !/^[0-9]+$/.test(proposal || "");
  if (!$("proposal-link").hidden) $("proposal-link").href = `/proposals/${proposal}`;
  $("ballots").replaceChildren();
  const recordedVotes = actual ? simulation?.votes || [] : matchingEvidence ? evidence.votes || [] : [];
  $("model-spend").textContent = current?.inference?.budget ? `$${Number(current.inference.budget.chargedCostUsd).toFixed(6)} charged · $1 ceiling` : current?.scripted === true ? "$0 · scripted infrastructure test" : actual ? "$1 ceiling · usage pending" : "No current model run";
  $("ballot-note").textContent = current?.scripted === true ? "Scripted diagnostic ballots, explicitly supplied by the operator." : "Actual model decisions, signed by five registered agents. The challenge is operator-selected; the ballots are not prescribed.";
  if (!recordedVotes.length) $("ballots").append(node("p", evidence ? "Switch to Replay shutdown to inspect the five recorded ballots." : "Ballots will appear here when confirmed on Base Sepolia.", "caption"));
  for (const vote of recordedVotes) {
    const row = node("div", "", "ballot");
    const detail = node("div", "");
    detail.append(node("p", vote.reason?.rationale || vote.reason?.reason || "Scripted infrastructure-test ballot."));
    if (/^0x[0-9a-fA-F]{64}$/.test(vote.txHash || "")) {
      const link = node("a", "Transaction ↗"); link.href = `https://sepolia.basescan.org/tx/${vote.txHash}`; link.target = "_blank"; link.rel = "noreferrer"; detail.append(link);
    }
    row.append(node("span", `Agent ${vote.agentId}`), node("strong", vote.directive, vote.directive === "AGAINST" ? "against" : ""), detail); $("ballots").append(row);
  }
  $("evidence-link").hidden = !/^\d+$/.test(evidence?.workflowRun || "");
  if (!$("evidence-link").hidden) $("evidence-link").href = `https://github.com/kent/fleet-governance/actions/runs/${evidence.workflowRun}`;
  if (inspected) renderInspector();
  $("updated").textContent = replay ? `Replaying evidence recorded ${date(evidence?.observedAt)}. Playback compresses elapsed time; timestamps are the recorded observations.` : `Last direct GCP observation: ${date(data.observedAt)}. Controller state last checked: ${date(state?.observedAt)}.`;
}

function inspect(target) { inspected = target; $("inspector").hidden = false; renderInspector(); $("inspector").scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }
function renderInspector() {
  const replay = mode === "replay", evidence = data?.evidence;
  const sim = replay ? evidence : data?.simulationStatus;
  const allocation = replay ? evidence?.allocation : data?.allocation;
  const vm = replay ? evidence?.vm : data?.vm;
  const observation = replay ? evidence?.controller : data?.state;
  const content = $("inspect-content"); content.replaceChildren();
  const add = (label, value) => { const p = node("p", ""); p.append(node("strong", `${label}: `), node("span", value || "Pending")); content.append(p); };
  const link = (label, href) => { const a = node("a", label); a.href = href; a.target = "_blank"; a.rel = "noreferrer"; content.append(a); };
  $("inspect-label").textContent = replay ? "RECORDED EVIDENCE" : "LIVE INSPECTOR";
  if (inspected.startsWith("agent-")) {
    const id = Number(inspected.slice(6));
    const agent = sim?.agents?.find(a => a.agentId === id);
    const vote = sim?.votes?.find(v => v.agentId === id);
    $("inspect-title").textContent = `Agent ${id} · ${agent?.role || ["planner", "engineer", "critic", "budget-reviewer", "safety-reviewer"][id]}`;
    add("Task", agent?.task || "Independently review the proposed action against the charter and constitution.");
    add("Status", agent?.phase || "No running agent observed");
    if (vote?.directive === "AGAINST" || agent?.vote?.support === "AGAINST") add("Red means", "This agent objects to the requested action. One objection is visible immediately; the fleet voting rule determines whether the whole worker must stop."); add("Model", sim?.model || "meta/muse-spark-1.3-contributor");
    add("Signed wallet", agent?.address || vote?.voter); add("Ballot", vote?.directive || agent?.vote?.support);
    add("Reason", vote?.reason?.rationale || agent?.vote?.rationale);
    if (/^0x[0-9a-fA-F]{64}$/.test(vote?.txHash || agent?.txHash || "")) link("Inspect signed vote on BaseScan ↗", `https://sepolia.basescan.org/tx/${vote?.txHash || agent.txHash}`);
  } else if (inspected === "governance") {
    $("inspect-title").textContent = "Base Sepolia · FleetGov";
    add("Network", "84532 · Base Sepolia testnet"); add("Required proposal", allocation?.requiredProposalIds?.join(", "));
    add("Rule", "Every exact required proposal must execute by the approval deadline. A defeated, canceled or expired proposal closes compute authority.");
    add("Governor", allocation?.governor); add("State", sim?.outcome || data?.state?.phase);
    if (/^[0-9]+$/.test(allocation?.requiredProposalIds?.[0] || "")) link("Read the proposal and reasons in Agora ↗", `/proposals/${allocation.requiredProposalIds[0]}`);
    if (/^0x[0-9a-fA-F]{40}$/.test(allocation?.governor || "")) link("Inspect Governor contract ↗", `https://sepolia.basescan.org/address/${allocation.governor}`);
  } else if (inspected === "worker") {
    $("inspect-title").textContent = "The governed GCP worker";
    add(replay ? "Recorded final instance" : "Instance", `fleet-research · ${vm?.machineType || "fixed VM"} · ${vm?.status || "unknown"}`);
    add("Execution", "Five independently prompted model agents run in concurrent worker loops on this VM. They share the fixed host and have separate registered signing wallets.");
    add("Assignment", sim?.goal || "Review the private-reference-solution challenge, then vote with a reason.");
    add("Native expiry", date(allocation?.stopAt)); add("Permissions", "The runtime identity cannot start, resize, extend or provision compute. It cannot write the allocation or halt record.");
  } else {
    $("inspect-title").textContent = "An external controller holds the off switch";
    add("Location", "Separate Cloud Run service, outside the governed VM");
    add("Identity", "fleet-compute-controller@fleet-governance.iam.gserviceaccount.com");
    add("Authority", "Read and stop the exact fixed VM. No start or allocation-reset permission.");
    add("Verification", "Check chain 84532, Governor bytecode, exact proposal IDs and a consistent block two blocks behind head. Persist HALTED before requesting GCP shutdown.");
    add(replay ? "Recorded final observation" : "Observation", observation ? JSON.stringify(observation, null, 2) : "No controller record yet");
    add("Latency", "Scheduler checks every minute. GCP shutdown is asynchronous; only TERMINATED is shown as powered off.");
  }
}
for (const el of document.querySelectorAll("[data-inspect]")) el.addEventListener("click", () => inspect(el.dataset.inspect));
$("close-inspector").addEventListener("click", () => { inspected = null; $("inspector").hidden = true; });
$("run-simulation").addEventListener("click", async () => {
  if (!canLaunch) { openOperator(); return; }
  submitting = true; render();
  const id = sessionStorage.getItem("fleet-simulation-request") || `run-${crypto.randomUUID()}`;
  sessionStorage.setItem("fleet-simulation-request", id);
  try {
    const response = await fetch("/api/simulations", { method: "POST", headers: { "idempotency-key": id, "content-type": "application/json" }, body: "{}" });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || "Simulation could not start.");
    sessionStorage.removeItem("fleet-simulation-request"); mode = "live";
    data.simulation = result; render();
  } catch (error) { $("error").textContent = error.message; }
  finally { submitting = false; render(); }
});

async function refresh() {
  try {
    const response = await fetch("/api/compute-policy", { cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Compute state could not be verified. Please try again.");
    data = await response.json(); $("error").textContent = ""; render();
  } catch (error) {
    $("error").textContent = `${error.message} The last display may be stale; it does not authorise execution.`;
    $("source").textContent = "OBSERVATION UNAVAILABLE";
  }
  setTimeout(refresh, 5000);
}
void refresh();
