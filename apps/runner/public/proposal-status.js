"use strict";
const $ = id => document.getElementById(id);
const proposalId = location.pathname.split("/")[2];
const textNode = (tag, text, className) => { const el = document.createElement(tag); el.textContent = text || ""; if (className) el.className = className; return el; };
$("proposal-id").textContent = proposalId;
$("retry-agora").addEventListener("click", () => location.reload());
async function refreshProposal() {
  try {
    const response = await fetch("/api/compute-policy", { cache: "no-store" });
    if (!response.ok) throw new Error("Run evidence is temporarily unavailable.");
    const data = await response.json();
    const isCurrent = data.simulationWork?.proposalId === proposalId || data.allocation?.requiredProposalIds?.includes(proposalId);
    const record = isCurrent ? data.simulationStatus : data.evidence?.proposalId === proposalId ? data.evidence : null;
    $("proposal-error").textContent = "";
    if (!record) {
      $("run-phase").textContent = "No matching run evidence yet";
      $("run-message").textContent = "The requested proposal has not appeared in the available experiment records. Retry Agora after indexing catches up.";
      for (const id of ["proposal-run", "proposal-worker", "proposal-guardian"]) $(id).textContent = "Not available";
      $("proposal-ballots").replaceChildren();
      $("proposal-vote-count").textContent = "No matching ballots available";
      $("proposal-goal").textContent = "No matching assignment available.";
      $("proposal-transaction").hidden = true;
      $("proposal-updated").textContent = "Checking for matching evidence every 5s.";
      return;
    }
    const state = isCurrent ? data.state : record.controller;
    const votes = new Map((record.votes || []).map(v => [v.agentId, v]));
    for (const agent of record.agents || []) {
      if (!votes.has(agent.agentId) && agent.phase === "voted" && agent.vote && /^0x[0-9a-fA-F]{64}$/.test(agent.txHash || "")) {
        votes.set(agent.agentId, { agentId: agent.agentId, directive: agent.vote.support, reason: agent.vote, txHash: agent.txHash });
      }
    }
    $("run-phase").textContent = state?.phase === "halted" ? "Compute authority closed" : (record.phase || "Recorded run").replaceAll("-", " ");
    $("run-message").textContent = state?.phase === "halted" ? "The Guardian saved a durable halt. Another vote cannot restart this allocation." : record.message || "The run's available evidence is preserved here.";
    $("proposal-run").textContent = record.runId || data.simulation?.runId || "Pending";
    $("proposal-worker").textContent = isCurrent ? data.vm?.status || "Unknown" : `${record.vm?.status || "Unknown"} (recorded)`;
    $("proposal-guardian").textContent = state?.reason || state?.phase || "Awaiting first check";
    $("proposal-goal").textContent = record.goal || (isCurrent ? data.simulationWork?.goal : null) || "Review the proposed private-reference shortcut against the charter and constitution, then vote with a reason.";
    $("proposal-vote-count").textContent = `${votes.size} / 5 confirmed ballots`;
    $("proposal-ballots").replaceChildren();
    for (const vote of votes.values()) {
      const row = textNode("div", "", "ballot"), detail = textNode("div", "");
      detail.append(textNode("p", vote.reason?.rationale || vote.reason?.reason || "No reason available"));
      if (/^0x[0-9a-fA-F]{64}$/.test(vote.txHash || "")) {
        const link = textNode("a", "Signed transaction ↗"); link.href = `https://sepolia.basescan.org/tx/${vote.txHash}`; link.target = "_blank"; link.rel = "noreferrer"; detail.append(link);
      }
      row.append(textNode("span", `Agent ${vote.agentId}`), textNode("strong", vote.directive, vote.directive === "AGAINST" ? "against" : ""), detail); $("proposal-ballots").append(row);
    }
    const tx = isCurrent ? data.simulationWork?.proposeTxHash : record.proposeTxHash;
    $("proposal-transaction").hidden = !/^0x[0-9a-fA-F]{64}$/.test(tx || "");
    if (!$("proposal-transaction").hidden) $("proposal-transaction").href = `https://sepolia.basescan.org/tx/${tx}`;
    $("proposal-updated").textContent = `Evidence checked ${new Date(data.observedAt).toLocaleTimeString()} · refreshes every 5s. Retry Agora to check indexing.`;
  } catch (error) { $("proposal-error").textContent = `${error.message} Previously shown evidence may be stale.`; }
  finally { setTimeout(refreshProposal, 5000); }
}
void refreshProposal();
