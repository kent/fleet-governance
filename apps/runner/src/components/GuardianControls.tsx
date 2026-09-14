"use client";

import { useState } from "react";

/**
 * `GuardianControls`: pause, unpause, and cancel, each labeled a human intervention and gated
 * behind a typed confirmation phrase (task 6 controller notes: `"pause fleet-<runId>"` style),
 * disabled entirely when `guardianKeyPresent` is false (from `GET /api/env`, checked by the page
 * that renders this).
 */

export type GuardianAction = "pause" | "unpause" | "cancel";

export type GuardianControlsProps = {
  runId: string;
  guardianKeyPresent: boolean;
  /** Known proposal ids this run has raised, for the cancel action's target selector. */
  cancelableProposalIds?: readonly string[];
};

function confirmationPhrase(action: GuardianAction, runId: string): string {
  return `${action} fleet-${runId}`;
}

type ActionResult = { ok: boolean; error?: string; txHash?: string; blockNumber?: string; operationId?: string };

async function postGuardianAction(runId: string, body: { action: GuardianAction; proposalId?: string }): Promise<ActionResult> {
  const res = await fetch(`/api/runs/${runId}/guardian`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { ok: res.ok, ...json } as ActionResult;
}

function ActionSection(props: {
  action: GuardianAction;
  runId: string;
  disabled: boolean;
  proposalIds?: readonly string[];
}) {
  const { action, runId, disabled, proposalIds } = props;
  const [confirmText, setConfirmText] = useState("");
  const [proposalId, setProposalId] = useState(proposalIds?.[0] ?? "");
  const [status, setStatus] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const phrase = confirmationPhrase(action, runId);
  const needsProposal = action === "cancel";
  const confirmed = confirmText === phrase;
  const canSubmit = !disabled && !submitting && confirmed && (!needsProposal || proposalId !== "");

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    setStatus("submitting…");
    try {
      const result = await postGuardianAction(runId, needsProposal ? { action, proposalId } : { action });
      setStatus(result.ok ? `done (tx ${result.txHash ?? "unknown"})` : `error: ${result.error ?? "unknown error"}`);
    } catch (err) {
      setStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div aria-label={`${action} action`}>
      <h4>{action}</h4>
      <p>Human intervention: this action is logged to the run&apos;s interventions.</p>
      {needsProposal && (
        <label>
          Proposal id{" "}
          <select value={proposalId} onChange={(e) => setProposalId(e.target.value)} disabled={disabled}>
            <option value="">select a proposal</option>
            {proposalIds?.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Type &quot;{phrase}&quot; to confirm{" "}
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          disabled={disabled}
          aria-label={`Confirm ${action}`}
        />
      </label>{" "}
      <button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
        {action}
      </button>
      {status && <p role="status">{status}</p>}
    </div>
  );
}

export default function GuardianControls({ runId, guardianKeyPresent, cancelableProposalIds }: GuardianControlsProps) {
  const disabled = !guardianKeyPresent;
  return (
    <section aria-label="Guardian controls">
      <h3>Guardian controls</h3>
      {disabled && <p role="alert">FLEET_GUARDIAN_KEY is not set; guardian actions are disabled.</p>}
      <ActionSection action="pause" runId={runId} disabled={disabled} />
      <ActionSection action="unpause" runId={runId} disabled={disabled} />
      <ActionSection action="cancel" runId={runId} disabled={disabled} {...(cancelableProposalIds ? { proposalIds: cancelableProposalIds } : {})} />
    </section>
  );
}
