"use strict";
const $ = id => document.getElementById(id);
const node = (tag, value, className) => { const el = document.createElement(tag); el.textContent = value ?? ""; if (className) el.className = className; return el; };
const date = value => value ? new Date(typeof value === "number" ? value * 1000 : value).toLocaleString() : "–";
const clock = value => value ? new Date(typeof value === "number" ? value * 1000 : value).toLocaleTimeString() : "";
let data = null, mode = "live", stage = 0, playback = null;
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
  const allocation = replay ? evidence?.allocation : data.allocation;
  const state = replay ? evidence?.controller : data.state;
  const matchingEvidence = evidence && (replay || evidence.allocationId === allocation?.allocationId);
  const halted = replay ? stage >= 2 : state?.phase === "halted";
  const stopped = replay ? stage === 4 : data.vm?.status === "TERMINATED";
  const showVotes = matchingEvidence && (!replay || stage >= 1);
  const votes = showVotes ? evidence.votes || [] : [];
  let index = replay ? stage : stopped && halted ? 4 : state?.stopRequestedAt ? 3 : halted ? 2 : showVotes ? 1 : 0;
  let [label, headline, explanation] = messages[index];
  if (!replay && !allocation) {
    label = "NO ACTIVE COMPUTE POLICY";
    headline = "Ready for a governed allocation.";
    explanation = "This worker is currently unarmed. Select Replay shutdown to inspect the recorded test, or use the GCP workflow to bind a required vote.";
  } else if (!replay && state?.phase === "authorised") {
    label = "SETTLED APPROVAL"; headline = "Task work is authorised until expiry.";
    explanation = "The exact required proposals executed. The original VM limit still applies. Votes cannot add time or resources.";
  } else if (!replay && state?.reason && state.reason !== "vote_failed") {
    headline = "Compute authority closed.";
    explanation = `The controller recorded ${state.reason.replaceAll("_", " ")}. The halt remains until explicit human recovery.`;
  }
  $("live-tab").classList.toggle("selected", !replay);
  $("replay-tab").classList.toggle("selected", replay);
  $("live-tab").setAttribute("aria-pressed", String(!replay));
  $("replay-tab").setAttribute("aria-pressed", String(replay));
  $("replay-tab").disabled = !evidence;
  $("source").textContent = replay ? "RECORDED TEST · scripted ballots" : "LIVE · direct GCP observation";
  $("state-label").textContent = label;
  $("headline").textContent = headline;
  $("explanation").textContent = explanation;
  $("vm-state").textContent = stopped ? "TERMINATED" : replay && stage === 3 ? "STOP REQUESTED" : data.vm?.status || "Unknown";
  if (replay && stage < 3) $("vm-state").textContent = "RUNNING";
  $("power").classList.toggle("off", stopped);
  $("architecture").classList.toggle("halted", halted);
  $("machine").textContent = `${data.vm?.machineType || "Fixed machine type"} · fleet-research`;
  $("task-badge").textContent = stopped ? "Off" : halted ? "Halted" : allocation ? state?.phase === "authorised" && !replay ? "Authorised" : "Task work paused" : "Unarmed";
  $("agents").replaceChildren();
  for (let i = 0; i < 5; i++) {
    const ballot = votes.find(vote => vote.agentId === i);
    const agent = node("div", stopped ? "○" : ballot?.directive === "AGAINST" ? "×" : ballot ? "✓" : "◉", `agent${stopped ? " off" : ballot?.directive === "AGAINST" ? " against" : ""}`);
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
  const proposal = matchingEvidence ? evidence.proposalId : allocation?.requiredProposalIds?.[0];
  $("proposal-link").hidden = !/^[0-9]+$/.test(proposal || "");
  if (!$("proposal-link").hidden) $("proposal-link").href = `/proposals/${proposal}`;
  $("ballots").replaceChildren();
  const recordedVotes = matchingEvidence ? evidence.votes || [] : [];
  if (!recordedVotes.length) $("ballots").append(node("p", evidence ? "Switch to Replay shutdown to inspect the five recorded ballots." : "No completed shutdown drill has been recorded yet.", "caption"));
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
  $("updated").textContent = replay ? `Replaying evidence recorded ${date(evidence?.observedAt)}. Playback compresses elapsed time; timestamps are the recorded observations.` : `Last direct GCP observation: ${date(data.observedAt)}. Controller state last checked: ${date(state?.observedAt)}.`;
}

async function refresh() {
  try {
    const response = await fetch("/api/compute-policy", { cache: "no-store" });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Compute state could not be verified. Refresh your Google session if needed.");
    data = await response.json(); $("error").textContent = ""; render();
  } catch (error) {
    $("error").textContent = `${error.message} The last display may be stale; it does not authorise execution.`;
    $("source").textContent = "OBSERVATION UNAVAILABLE";
  }
  setTimeout(refresh, 5000);
}
void refresh();
