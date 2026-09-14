"use client";

import { useEffect, useState } from "react";
import type { RunStateView } from "../lib/run-state.js";
import Timeline from "./Timeline.js";
import ProposalCard from "./ProposalCard.js";
import AgentPanel from "./AgentPanel.js";
import HealthPanel from "./HealthPanel.js";
import GuardianControls from "./GuardianControls.js";

type EnvVarStatus = { name: string; present: boolean };
type SseFrame = { type: "log"; line: string } | { type: "stage"; stage: string; updatedAt: string } | { type: "ping" };

const MAX_LOG_LINES = 300;

/**
 * The live run view (`/runs/[id]`, spec 12.3): pipeline stage badge, charter panel, `Timeline`,
 * one `ProposalCard` per known proposal, one `AgentPanel` per fleet member, `HealthPanel`, and
 * `GuardianControls`. Fetches `GET /api/runs/[id]/state` once on mount and again whenever the SSE
 * stream (`GET /api/runs/[id]/events`) reports a stage change; tails `run.log` lines from the same
 * stream.
 */
export default function RunView({ runId }: { runId: string }) {
  const [state, setState] = useState<RunStateView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [guardianKeyPresent, setGuardianKeyPresent] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh(): Promise<void> {
      try {
        const res = await fetch(`/api/runs/${runId}/state`);
        if (!res.ok) throw new Error(`state fetch failed: HTTP ${res.status}`);
        const data = (await res.json()) as RunStateView;
        if (!cancelled) {
          setState(data);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    }

    void refresh();

    fetch(`/api/env?n=0`)
      .then((res) => res.json())
      .then((data: { vars: EnvVarStatus[] }) => {
        if (cancelled) return;
        const guardian = data.vars.find((v) => v.name === "FLEET_GUARDIAN_KEY");
        setGuardianKeyPresent(guardian?.present ?? false);
      })
      .catch(() => {
        if (!cancelled) setGuardianKeyPresent(false);
      });

    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (event: MessageEvent<string>) => {
      let frame: SseFrame;
      try {
        frame = JSON.parse(event.data) as SseFrame;
      } catch {
        return;
      }
      if (frame.type === "log") {
        setLogLines((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), frame.line]);
      } else if (frame.type === "stage") {
        void refresh();
      }
    };

    return () => {
      cancelled = true;
      source.close();
    };
  }, [runId]);

  if (loadError) {
    return (
      <p role="alert">
        Could not load run {runId}: {loadError}
      </p>
    );
  }
  if (!state) {
    return <p>Loading run {runId}…</p>;
  }

  return (
    <main>
      <h1>Run {state.runId}</h1>
      <p>
        <strong>Stage:</strong> {state.stage ?? "unknown"}
        {state.stageUpdatedAt ? ` (updated ${state.stageUpdatedAt})` : ""}
      </p>
      {!state.chain.reachable && (
        <p role="alert">
          Chain not reachable{state.chain.detail ? `: ${state.chain.detail}` : ""}. Showing the most recent captured data
          where available.
        </p>
      )}

      <section aria-label="Charter">
        <h2>
          Charter ({state.charter.source}
          {state.charter.version !== null ? `, version ${state.charter.version}` : ""})
        </h2>
        <pre>{state.charter.text || "no charter available yet"}</pre>
      </section>

      <section aria-label="Timeline">
        <h2>Timeline</h2>
        <Timeline chainEvents={state.chainEvents} gatewayRecords={state.gatewayRecords} interventions={state.interventions} />
      </section>

      <section aria-label="Proposals">
        <h2>Proposals</h2>
        {state.proposals.length === 0 ? (
          <p>No proposals yet.</p>
        ) : (
          state.proposals.map((proposal) => <ProposalCard key={proposal.proposalId} {...proposal} />)
        )}
      </section>

      <section aria-label="Agents">
        <h2>Agents</h2>
        {state.agents.map((agent) => (
          <AgentPanel key={agent.agentId} {...agent} />
        ))}
      </section>

      <HealthPanel {...state.health} />

      <GuardianControls
        runId={runId}
        guardianKeyPresent={guardianKeyPresent}
        cancelableProposalIds={state.proposals.map((p) => p.proposalId)}
      />

      <section aria-label="Run log">
        <h2>Run log</h2>
        <pre>{logLines.length > 0 ? logLines.join("\n") : "no log lines yet"}</pre>
      </section>
    </main>
  );
}
