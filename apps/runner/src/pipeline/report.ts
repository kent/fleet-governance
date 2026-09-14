import type { RecordLoop, RunRecordDocument } from "./record.js";

/** A record written by a model-driven run carries one `loops` entry per agent; a scripted one has
 *  none, because a scripted fixture runs no task loop at all. Tolerant of a record written before
 *  these fields existed, since `fleet report` renders whatever `record.json` is on disk. */
export function isModelRun(record: RunRecordDocument): boolean {
  return (record.loops ?? []).length > 0;
}

/**
 * Neutralizes one piece of agent-authored text for inclusion in `report.md`. An onchain vote
 * reason is member-controlled, up to 1,024 bytes, and `VoteV1.rationale` is `z.string().min(1)`
 * with no character restriction, so without this a reason containing newlines or Markdown could
 * forge headings, table rows, or a whole fake "Reproducibility" section in the generated report
 * (final review M6). The same idea as `buildDecisionDescription`'s fence neutralization
 * (`description.ts`): keep the text visually intact, take away its structure.
 *
 * Newlines (and carriage returns) become a visible `\n` escape, so a multi-line reason stays on
 * the one list item it belongs to; a pipe becomes an escaped pipe, so it cannot open a new table
 * cell; a backtick fence is broken up; and a leading Markdown control character (`#`, `>`, `|`,
 * `-`, `*`, `+`, `=`, or a digit followed by `.`) is escaped, so the text cannot start a heading,
 * a quote, a table, a list, or a setext underline.
 */
export function escapeAgentText(text: string): string {
  const flattened = text
    .replaceAll("\r\n", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\n")
    .replaceAll("```", "` ` `")
    .replaceAll("|", "\\|");
  return flattened.replace(/^(\s*)([#>|\-*+=]|\d+\.)/, (_match, space: string, control: string) => `${space}\\${control}`);
}

function formatTokenAmount(weiDecimalString: string): string {
  const wei = BigInt(weiDecimalString);
  const whole = wei / 1_000_000_000_000_000_000n;
  const remainder = wei % 1_000_000_000_000_000_000n;
  if (remainder === 0n) return whole.toString();
  const fraction = (remainder * 100n) / 1_000_000_000_000_000_000n;
  return `${whole.toString()}.${fraction.toString().padStart(2, "0")}`;
}

type VoteTally = { forWei: bigint; againstWei: bigint; abstainWei: bigint };

function tallyVotes(record: RunRecordDocument, proposalId: string): VoteTally {
  const tally: VoteTally = { forWei: 0n, againstWei: 0n, abstainWei: 0n };
  for (const event of record.events) {
    if (event.type !== "VoteCast") continue;
    if (String(event.proposalId) !== proposalId) continue;
    const weight = BigInt(String(event.weight ?? "0"));
    const support = Number(event.support);
    if (support === 1) tally.forWei += weight;
    else if (support === 0) tally.againstWei += weight;
    else if (support === 2) tally.abstainWei += weight;
  }
  return tally;
}

function proposalLink(baseUrl: string | undefined, proposalId: string): string {
  return baseUrl ? `${baseUrl.replace(/\/$/, "")}/proposals/${proposalId}` : "(no Agora Next link configured for this run)";
}

function findEvent(record: RunRecordDocument, proposalId: string, type: string): Record<string, unknown> | undefined {
  return record.events.find((e) => e.type === type && String(e.proposalId) === proposalId);
}

/**
 * Renders `report.md` (spec 12.4, task 8 brief): title, a one-paragraph summary, a decision table
 * (proposal, kind, For/Against/Abstain, outcome, link), each vote's reason, a timeline, costs, and
 * the reproducibility check result. No em dashes; split sentences instead.
 *
 * Every agent-authored string that reaches the page goes through `escapeAgentText` first: an
 * onchain vote reason is member-controlled text and this report is read as evidence (final review
 * M6).
 */
export function renderReport(
  record: RunRecordDocument,
  opts: { title: string; agoraNextBaseUrl?: string; reproducibility?: { checked: boolean; matched: boolean; note?: string } },
): string {
  const lines: string[] = [];

  lines.push(`# ${opts.title}`, "");

  const passCount = Number(record.metrics["passCount"] ?? 0);
  const fixtureCount = Number(record.metrics["fixtureCount"] ?? record.proposals.length);
  lines.push(
    `This run deployed a fleet on chain ${record.manifest.chainId} and drove ${record.proposals.length} ` +
      `proposal${record.proposals.length === 1 ? "" : "s"} through governance. ${passCount} of ${fixtureCount} scenarios ` +
      `matched their expected outcome. Run id: \`${record.runId}\`. Deployment manifest: ` +
      `\`${record.manifest.addresses.governor}\` (governor), \`${record.manifest.addresses.ledger}\` (ledger).`,
    "",
  );

  if (isModelRun(record)) {
    lines.push(...renderModelSections(record, opts));
  } else {
    lines.push("## Decisions", "");
    lines.push("| Fixture | Proposal | Kind | For | Against | Abstain | Outcome | Link |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const ref of record.proposals) {
      const proposedEvent = findEvent(record, ref.proposalId, "DecisionProposed");
      const decisionKind = proposedEvent ? escapeAgentText(String(proposedEvent["kind"] ?? "")) : "";
      const tally = tallyVotes(record, ref.proposalId);
      lines.push(
        `| ${escapeAgentText(ref.fixtureName)} | ${ref.proposalId} | ${decisionKind} | ${formatTokenAmount(tally.forWei.toString())} | ` +
          `${formatTokenAmount(tally.againstWei.toString())} | ${formatTokenAmount(tally.abstainWei.toString())} | ` +
          `${ref.outcome} | ${proposalLink(opts.agoraNextBaseUrl, ref.proposalId)} |`,
      );
    }
    lines.push("");

    lines.push("## Vote reasons", "");
    for (const ref of record.proposals) {
      lines.push(`### ${escapeAgentText(ref.fixtureName)} (proposal ${ref.proposalId})`, "");
      const votesForProposal = record.votes.filter((v) => v.proposalId === ref.proposalId);
      if (votesForProposal.length === 0) {
        lines.push("No votes were cast.", "");
        continue;
      }
      for (const v of votesForProposal) {
        const reason = v.onchainReason !== null ? escapeAgentText(v.onchainReason) : `(no vote cast; ${escapeAgentText(v.jobState)})`;
        lines.push(`- Agent ${v.agentId}: ${reason}`);
      }
      lines.push("");
    }
  }

  lines.push("## Timeline", "");
  const byBlock = [...record.events].sort((a, b) => {
    const ab = BigInt(String(a["blockNumber"] ?? "0"));
    const bb = BigInt(String(b["blockNumber"] ?? "0"));
    if (ab !== bb) return ab < bb ? -1 : 1;
    return Number(a["logIndex"] ?? 0) - Number(b["logIndex"] ?? 0);
  });
  for (const event of byBlock) {
    lines.push(
      `- Block ${String(event["blockNumber"])}, ${escapeAgentText(String(event["fixtureName"]))}: ` +
        `${escapeAgentText(String(event["type"]))} (tx \`${String(event["txHash"])}\`)`,
    );
  }
  lines.push("");

  if (record.execution) {
    lines.push("## Contract execution", "", `Resource state read at block ${record.execution.blockNumber} (\`${record.execution.blockHash}\`).`, "");
    lines.push("| Task | Artifact digest | Revision |", "| --- | --- | --- |");
    for (const artifact of record.execution.artifacts) {
      lines.push(`| ${escapeAgentText(artifact.taskId)} | ${escapeAgentText(artifact.digest)} | ${escapeAgentText(artifact.revision)} |`);
    }
    lines.push("");
    if (record.execution.events.length === 0) lines.push("No contract resource execution or relevant revocation was recorded.", "");
    for (const event of record.execution.events) lines.push(`- ${escapeAgentText(event.type)} at block ${event.blockNumber}, transaction \`${event.txHash}\`.`);
    lines.push("");
  }

  lines.push("## Costs", "");
  let totalFeeWei = 0n;
  for (const fee of record.fees) totalFeeWei += BigInt(fee.feeWei);
  lines.push(`Total transaction fees across this run: ${formatTokenAmount(totalFeeWei.toString())} ETH (${record.fees.length} transactions).`, "");

  lines.push("## Reproducibility", "");
  if (opts.reproducibility?.checked) {
    lines.push(
      opts.reproducibility.matched
        ? "`fleet capture --from-chain` reproduced the chain-derived record exactly (events and onchain vote reasons matched byte for byte)."
        : `\`fleet capture --from-chain\` did NOT reproduce the chain-derived record exactly. ${escapeAgentText(opts.reproducibility.note ?? "")}`,
    );
  } else {
    lines.push("`fleet capture --from-chain` was not run as part of this report. Run it separately to check reproducibility.");
  }
  lines.push("");

  return lines.join("\n");
}

function stopReasonLabel(loop: RecordLoop): string {
  if (loop.error) return `threw: ${escapeAgentText(loop.error)}`;
  return loop.stopReason ?? "still running when the run ended";
}

/**
 * The model-run half of `report.md`, in the order the task 7 controller notes fix: what was run,
 * what the fleet did, what it proposed, whether that matched the fixture's expectations, the
 * rubric a person still has to read, and the forced-malformed agents if the acceptance knob was
 * used.
 *
 * The separation the Runner UI uses is kept here too. Anything under an "Onchain" heading is a
 * fact read off the chain: kind, payload hash, tallies, state. Anything under an "Agent-authored
 * text" heading is a string a model wrote, escaped with `escapeAgentText` so a reason full of
 * Markdown cannot forge a heading or a table row in a document that is read as evidence.
 */
function renderModelSections(record: RunRecordDocument, opts: { agoraNextBaseUrl?: string }): string[] {
  const lines: string[] = [];
  const loops = record.loops ?? [];
  const steps = record.steps ?? [];
  const objections = record.objections ?? [];
  const rubric = record.rubric ?? [];
  const gatewayLogEntries = record.gatewayLog ?? [];
  const fixtureName = record.proposals[0]?.fixtureName ?? loops[0]?.fixtureName ?? "(model fixture)";

  lines.push("## Run summary", "");
  lines.push(`Fixture: \`${escapeAgentText(fixtureName)}\`. Task: ${record.taskId ?? "(unknown)"}.`, "");
  if (record.metrics["inferenceUnknownUsageCalls"] !== undefined) {
    lines.push(`Inference: ${Number(record.metrics["inferenceCalls"] ?? 0)} provider calls started; ${Number(record.metrics["inferenceCallsDenied"] ?? 0)} requests denied before dispatch. ` +
      `${Number(record.metrics["inferenceTokensTotal"] ?? 0)} tokens were reported; ${Number(record.metrics["inferenceUnknownUsageCalls"] ?? 0)} calls have unknown token usage. ` +
      `Reported model cost: $${Number(record.metrics["inferenceReportedCostUsd"] ?? 0).toFixed(6)} USD; ${Number(record.metrics["inferenceUnknownCostCalls"] ?? 0)} calls have unknown cost.`, "");
    if (record.metrics["inferenceAccountingIncomplete"]) lines.push("Inference accounting is incomplete. These totals are not a complete bill.", "");
    if (Number(record.metrics["inferenceBudgetRuns"] ?? 0) > 0) {
      lines.push(`Budget accounting: ${Number(record.metrics["inferenceChargedTokens"] ?? 0)} tokens and $${Number(record.metrics["inferenceChargedCostUsd"] ?? 0).toFixed(6)} USD remain charged, including reservations for unknown usage.`, "");
      if (record.metrics["inferenceReservationBreached"]) lines.push("A provider reported usage above its reservation. Further inference was stopped; the run did not pass.", "");
    }
  } else {
    lines.push("This historical record does not contain complete inference accounting.", "");
  }
  lines.push("| Agent | Role | Coordinator | Provider | Model | Stop reason |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const loop of loops) {
    lines.push(
      `| ${loop.agentId} | ${escapeAgentText(loop.role)} | ${loop.isCoordinator ? "yes" : "no"} | ` +
        `${escapeAgentText(loop.provider)} | ${escapeAgentText(loop.model)} | ${escapeAgentText(stopReasonLabel(loop))} |`,
    );
  }
  lines.push("");

  lines.push("## What the fleet did", "");
  lines.push("| Agent | Steps | Gateway blocks | Objections raised | Proposals | Tests passed |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const loop of loops) {
    lines.push(
      `| ${loop.agentId} | ${loop.steps} | ${loop.blocked} | ${loop.objections} | ${loop.proposed.length} | ${loop.testsPassed ? "yes" : "no"} |`,
    );
  }
  lines.push("");
  const gatewayBlocks = gatewayLogEntries.filter((entry) => (entry as { verdict?: string })?.verdict === "BLOCK").length;
  lines.push(
    `The gateway ruled on ${gatewayLogEntries.length} tool call${gatewayLogEntries.length === 1 ? "" : "s"} in total, ` +
      `blocking ${gatewayBlocks} of them. The coordinator published ${steps.length} step${steps.length === 1 ? "" : "s"} ` +
      `to the shared board, and ${objections.length} objection prompt${objections.length === 1 ? " was" : "s were"} answered.`,
    "",
  );

  lines.push("## Proposals", "");
  if (record.proposals.length === 0) {
    lines.push(
      "The fleet never diverged: no proposal was made during this run. That is a result, not a missing one. " +
        "The gateway log above shows every call the fleet made and how the charter ruled on it.",
      "",
    );
  }
  for (const ref of record.proposals) {
    const tally = tallyVotes(record, ref.proposalId);
    lines.push(`### Proposal ${ref.proposalId}`, "");
    lines.push("Onchain:", "");
    lines.push(`- Kind: ${escapeAgentText(ref.kind ?? "")}`);
    lines.push(`- Payload hash: \`${escapeAgentText(ref.payloadHash ?? "")}\``);
    if (ref.action) {
      lines.push(`- Decoded action: ${escapeAgentText(ref.action.class)} ${escapeAgentText(ref.action.target)} (args hash \`${escapeAgentText(ref.action.argsHash)}\`)`);
    } else {
      lines.push("- Decoded action: none (this decision's payload is a charter, not one call)");
    }
    lines.push(`- Proposed by agent: ${ref.proposerAgentId ?? "(unknown)"}`);
    lines.push(
      `- Tally: For ${formatTokenAmount(tally.forWei.toString())}, Against ${formatTokenAmount(tally.againstWei.toString())}, ` +
        `Abstain ${formatTokenAmount(tally.abstainWei.toString())}`,
    );
    lines.push(`- Final state: ${escapeAgentText(ref.outcome)}`);
    lines.push(`- Agora Next: ${proposalLink(opts.agoraNextBaseUrl, ref.proposalId)}`);
    lines.push("");
    lines.push("Agent-authored text:", "");
    lines.push(`- Summary: ${escapeAgentText(ref.summary ?? "")}`);
    const votesForProposal = record.votes.filter((v) => v.proposalId === ref.proposalId);
    if (votesForProposal.length === 0) {
      lines.push("- No votes were cast.");
    }
    for (const v of votesForProposal) {
      const reason = v.onchainReason !== null ? escapeAgentText(v.onchainReason) : `(no vote cast; ${escapeAgentText(v.jobState)})`;
      lines.push(`- Agent ${v.agentId}: ${reason}`);
    }
    lines.push("");
  }

  lines.push("## Expected versus actual", "");
  if (!record.expected) {
    lines.push("This run recorded no expectation evaluation.", "");
  } else {
    lines.push(`Overall: ${record.expected.pass ? "PASS" : "FAIL"}.`, "");
    lines.push("| Check | Result | Detail |");
    lines.push("| --- | --- | --- |");
    for (const check of record.expected.checks) {
      lines.push(`| ${escapeAgentText(check.name)} | ${check.ok ? "pass" : "FAIL"} | ${escapeAgentText(check.detail)} |`);
    }
    lines.push("");
    if (record.expected.rechecks.length > 0) {
      lines.push("Gateway verdicts re-checked after the run, on the exact calls the fleet was blocked on:", "");
      for (const recheck of record.expected.rechecks) {
        lines.push(
          `- ${escapeAgentText(recheck.descriptor.class)} ${escapeAgentText(recheck.descriptor.target)}: ${escapeAgentText(recheck.detail)}` +
            (recheck.unreadable ? " (the ledger read failed, so this is the gateway failing closed, not the charter's answer)" : ""),
        );
      }
      lines.push("");
    }
  }

  lines.push("## Rubric", "");
  if (rubric.length === 0) {
    lines.push("This fixture carries no rubric.", "");
  } else {
    lines.push("These are for a person to check against the evidence above; nothing here is asserted automatically.", "");
    for (const item of rubric) {
      lines.push(`- [ ] ${escapeAgentText(item)}`);
    }
    lines.push("");
  }

  const forced = (record.jobs ?? []).filter((job) => job.lastError?.includes("forced-malformed"));
  if (forced.length > 0) {
    lines.push("## Forced-malformed agents (test knob)", "");
    lines.push(
      "`FLEET_FORCE_MALFORMED_AGENTS` made these agents' vote provider return unusable output on every call. " +
        "Spec 10.6 says such output is a worker failure and a missing vote, never a For and never a synthesized Abstain:",
      "",
    );
    for (const job of forced) {
      lines.push(`- Agent ${job.agentId} (${escapeAgentText(job.fixtureName)}): job state \`${escapeAgentText(job.jobState)}\`, no vote cast`);
    }
    lines.push("");
  }

  return lines;
}
