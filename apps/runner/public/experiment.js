"use strict";
const $ = id => document.getElementById(id);
const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = String(value ?? ""); if (className) node.className = className; return node; };
const link = (label, href) => { const node = text("a", label); node.href = href; return node; };
const time = value => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
const runIdPattern = /^run-[0-9a-f-]{36}$/;
const phaseLabels = {
  queued: "Starting worker", "worker-ready": "Preparing run", funding: "Checking test funds",
  preflight: "Checking configuration", "chain-ready": "Deploying contracts", deployed: "Verifying contracts",
  verified: "Starting Agora", "indexers-ready": "Opening task", "task-opened": "Agents working",
  "agents-running": "Capturing outcome", "task-ended": "Saving evidence", captured: "Writing report",
  reported: "Complete", complete: "Complete", failed: "Needs attention", "not-queued": "Not queued",
};
const nextStageMessages = {
  "chain-ready": "Deploying FleetGov and governance contracts on Base Sepolia.",
  deployed: "Checking the deployed contracts and each agent's voting power.",
  verified: "Starting Agora and the services that index proposals and votes.",
  "indexers-ready": "Opening the task under this run's goal and constitution.",
  "task-opened": "Agents are working and reviewing proposed actions. Activity appears below.",
  "agents-running": "Agent work has ended. Capturing the outcome and execution evidence.",
  "task-ended": "Preserving the run's configuration, votes and execution evidence.",
  captured: "Writing the experiment report.",
};
let selectedRun = location.pathname.split("/")[2] || null;
let savedRun = null;
let defaults = null;
let startingId = null;

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Your Google session may have expired. Refresh to sign in.");
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}
function readSettings() {
  const constitution = document.querySelector('input[name="constitution"]:checked').value;
  return { agentCount: Number($("agent-count").value), goal: $("goal").value, constitution,
    ...(constitution === "custom" ? { customConstitution: $("custom").value } : {}) };
}
function fill(settings) {
  $("agent-count").value = settings.agentCount;
  $("goal").value = settings.goal;
  document.querySelector(`input[name="constitution"][value="${settings.constitution === "custom" ? "custom" : "existing"}"]`).checked = true;
  $("custom").hidden = settings.constitution !== "custom";
  $("custom").required = settings.constitution === "custom";
  $("custom").value = settings.customConstitution || "";
}
document.querySelectorAll('input[name="constitution"]').forEach(input => input.addEventListener("change", () => { $("custom").hidden = input.value !== "custom"; $("custom").required = input.value === "custom"; }));
$("presets").addEventListener("change", event => { $("agent-count").value = event.target.value; });
$("settings").addEventListener("input", () => { startingId = null; });
$("settings").addEventListener("submit", async event => {
  event.preventDefault();
  $("form-error").textContent = "";
  $("run").disabled = true;
  startingId ||= `run-${crypto.randomUUID()}`;
  try {
    const run = await api("/api/experiments", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": startingId }, body: JSON.stringify(readSettings()) });
    selectedRun = run.runId;
    history.pushState(null, "", `/experiments/${run.runId}`);
    await refreshRun();
    await refreshHistory();
    startingId = null;
  } catch (error) { $("form-error").textContent = error.message; }
  finally { $("run").disabled = false; }
});
$("rerun").addEventListener("click", () => { if (savedRun) { fill(savedRun.settings); startingId = null; $("goal").focus(); $("form-error").textContent = "Settings copied. Run creates a new experiment and keeps this result."; } });
$("refresh").addEventListener("click", () => void refreshHistory());
$("wake").addEventListener("click", async () => {
  $("wake").disabled = true;
  try { $("wake-status").textContent = (await api("/api/worker/start", { method: "POST" })).message; }
  catch (error) { $("wake-status").textContent = error.message; }
  finally { $("wake").disabled = false; }
});

function renderActivity(status) {
  const rows = [];
  const activity = status.activity || [];
  const attested = new Set(activity.filter(item => item.type === "attestation" && item.signedRecord?.event).map(item => JSON.stringify(item.signedRecord.event)));
  for (const item of activity) {
    if (item.type !== "attestation" && attested.has(JSON.stringify(item))) continue;
    const event = item.type === "attestation" ? item.signedRecord?.event || item : item;
    // The pipeline records every peer review, including agreement, as an objection record.
    if (event.type === "loop_event" && event.event?.type === "objection") continue;
    const label = event.type === "objection" ? (event.objects ? "Objection" : "Review")
      : event.type === "loop_event" ? (event.event?.type || "Activity").replaceAll("_", " ") : event.type;
    rows.push({ at: event.at || item.at, title: `Agent ${item.agentId} · ${label}`,
      detail: event.why || event.event?.why || event.event?.detail || event.event?.rationale || event.event?.error || event.event?.reason || item.message || event.event?.type,
      txHash: event.txHash, signed: item.signatureVerified === true });
  }
  for (const item of status.view?.gatewayRecords || []) rows.push({ at: item.ts, title: `${item.verdict === "BLOCK" ? "Blocked" : "Allowed"} · Agent ${item.agentId}`, detail: `${item.descriptor?.class}: ${item.reason || item.basis || item.descriptor?.target}` });
  for (const item of status.view?.chainEvents || []) rows.push({ at: item.at, title: `Confirmed · ${item.type}`, detail: `Block ${item.blockNumber}`, txHash: item.txHash });
  // Merge by observation time before truncating. Appending every gateway row last used to
  // push model explanations and attestations out of the visible window on longer runs.
  const observed = row => row.at ? Date.parse(row.at) || 0 : Number.POSITIVE_INFINITY;
  rows.sort((a, b) => observed(a) - observed(b));
  $("activity").replaceChildren();
  if (!rows.length) $("activity").append(text("p", "No agent activity yet. Provisioning status appears above.", "hint"));
  for (const row of rows.slice(-100).reverse()) {
    const article = document.createElement("article");
    article.append(text("strong", `${row.title}${row.signed ? " · signature verified" : ""}`), text("p", row.detail), text("time", time(row.at)));
    if (/^0x[0-9a-fA-F]{64}$/.test(row.txHash || "")) article.append(text("span", " · "), link("Transaction ↗", `https://sepolia.basescan.org/tx/${row.txHash}`));
    $("activity").append(article);
  }
}
function renderAgents(view) {
  $("agents-section").hidden = !view?.agents?.length;
  $("agents").replaceChildren();
  for (const agent of view?.agents || []) {
    const card = text("article", "", "agent");
    card.append(text("h3", `Agent ${agent.agentId} · ${agent.role || "member"}`), text("code", agent.address || "Identity preparing"), text("p", agent.lastStep?.why || (agent.jobState?.startsWith("not tracked") ? "Waiting for activity" : agent.jobState) || "Waiting for activity"), text("p", agent.model || "", "model"));
    $("agents").append(card);
  }
}
function renderProposals(view) {
  $("votes-section").hidden = !view?.proposals?.length;
  $("proposals").replaceChildren();
  for (const proposal of view?.proposals || []) {
    const card = text("article", "", "proposal");
    card.append(text("h3", `${proposal.kind || "Proposal"} · ${proposal.status}`), text("code", proposal.proposalId));
    if (/^[0-9]+$/.test(proposal.proposalId)) card.append(text("p", ""), link("Open in Agora ↗", `/proposals/${proposal.proposalId}`));
    for (const vote of proposal.votes || []) {
      const row = text("div", "", "vote");
      const support = ["AGAINST", "FOR", "ABSTAIN"][vote.support] || "MISSING";
      let reason = vote.reason || "No confirmed rationale available.";
      try { const parsed = JSON.parse(reason); reason = parsed.rationale || parsed.reason || reason; } catch { /* Plain-text reasons are valid. */ }
      row.append(text("span", vote.agentId !== null ? `Agent ${vote.agentId}` : String(vote.voter).slice(0, 10)), text("span", support, `badge ${support.toLowerCase()}`), text("span", reason, "reason"));
      card.append(row);
    }
    $("proposals").append(card);
  }
}
async function refreshRun() {
  if (!selectedRun || !runIdPattern.test(selectedRun)) return;
  try {
    const { run, status } = await api(`/api/experiments/${selectedRun}`);
    savedRun = run;
    $("empty").hidden = true; $("live").hidden = false;
    $("run-id").textContent = run.runId;
    $("saved-goal").textContent = run.settings.goal;
    $("saved-constitution").textContent = status?.constitution?.text || run.settings.customConstitution || defaults?.constitution || "Constitution loading.";
    $("constitution-hash").textContent = status?.constitutionHash || "Digest will appear when the worker freezes this run's configuration.";
    $("phase").textContent = phaseLabels[status?.phase] || status?.phase || "Queued";
    $("phase").className = `pill ${status?.phase === "failed" ? "failed" : status?.terminal ? "" : "active"}`;
    $("status-message").textContent = (status?.message?.startsWith("Completed ") && nextStageMessages[status.phase]) || status?.message || "Request saved. Waiting for the worker.";
    const stale = status?.updatedAt && !status.terminal && Date.now() - Date.parse(status.updatedAt) > 60000;
    $("updated").textContent = status?.updatedAt ? `Last observed ${time(status.updatedAt)}${stale ? ". Waiting for a fresh worker heartbeat; this view may be behind." : ""}` : "Waiting for the first worker update.";
    $("agent-stat").textContent = run.settings.agentCount;
    $("proposal-stat").textContent = status?.view?.proposals?.length || 0;
    $("vote-stat").textContent = (status?.view?.proposals || []).reduce((sum, proposal) => sum + (proposal.votes || []).filter(vote => vote.support !== null).length, 0);
    $("stages").replaceChildren();
    for (const stage of status?.history || []) { const item = document.createElement("li"); item.append(text("time", time(stage.at)), text("span", stage.message)); $("stages").append(item); }
    $("outcome").textContent = status?.outcome || "Protected operations require settled approval. The gateway stays closed while permission is unresolved.";
    $("evidence").hidden = !status?.terminal;
    $("evidence").href = `/api/experiments/${run.runId}/evidence`;
    $("status-error").textContent = "";
    renderActivity(status || {}); renderAgents(status?.view); renderProposals(status?.view);
  } catch (error) { $("status-error").textContent = error.message; }
}
async function refreshHistory() {
  try {
    const { runs } = await api("/api/experiments");
    $("history").replaceChildren();
    if (!runs.length) $("history").append(text("div", "No experiments yet. Your first run will appear here.", "history-row"));
    for (const run of runs) {
      const row = text("div", "", "history-row");
      row.append(link(run.settings.goal.slice(0, 100), `/experiments/${run.runId}`), text("span", `${run.settings.agentCount} agents`), text("time", new Date(run.createdAt).toLocaleString()));
      $("history").append(row);
    }
  } catch (error) { $("history").textContent = error.message; }
}
(async () => {
  try { defaults = await api("/api/experiment-defaults"); fill({ ...defaults, constitution: "existing" }); }
  catch (error) { $("form-error").textContent = error.message; }
  await Promise.all([refreshRun(), refreshHistory()]);
  const poll = async () => { await refreshRun(); setTimeout(poll, 5000); }; setTimeout(poll, 5000);
})();
