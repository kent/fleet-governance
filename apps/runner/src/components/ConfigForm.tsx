"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { CharterV1, ExperimentConfigV1, effectiveYesCount } from "@fleet/schemas";
import type { CharterV1 as CharterV1Type, ExperimentConfigV1 as ExperimentConfigV1Type } from "@fleet/schemas";
import { CODING_TASK_CHARTER, EXPERIMENT_NAME_PATTERN, FORM_DEFAULTS, defaultMember } from "../lib/defaults.js";

type FixtureKind = "scripted" | "model";
type FixtureSummary = {
  name: string;
  kind: FixtureKind;
  description: string;
  charterPath?: string;
  /** The model fixture's own parsed charter, read server-side by `GET /api/fixtures`
   *  (fix round 1). Absent for scripted fixtures and for a model fixture whose charter file
   *  failed to load, in which case `charterError` says why. */
  charter?: CharterV1Type;
  charterError?: string;
};
type EnvVarStatus = { name: string; present: boolean; source?: "env" | "local-anvil-test-key" | "missing" };
type FleetMember = ExperimentConfigV1Type["fleet"]["members"][number];

const PROVIDERS = ["scripted", "claude-cli", "openrouter"] as const;

function cloneDraft(draft: ExperimentConfigV1Type): ExperimentConfigV1Type {
  return {
    ...draft,
    target: { ...draft.target },
    fleet: { ...draft.fleet, members: draft.fleet.members.map((m) => ({ ...m })) },
    governance: { ...draft.governance },
    task: { ...draft.task, charter: { ...draft.task.charter } },
    scenario: { ...draft.scenario },
    capture: { ...draft.capture },
    display: { ...draft.display },
  };
}

/** Strips empty optional strings before submission, so `capture.gcsBucket` and
 *  `display.agoraNextBaseUrl` are omitted entirely rather than sent as `""`. */
function buildSubmissionConfig(draft: ExperimentConfigV1Type): ExperimentConfigV1Type {
  const config = cloneDraft(draft);
  if (!config.capture.gcsBucket) delete config.capture.gcsBucket;
  if (!config.display.agoraNextBaseUrl) delete config.display.agoraNextBaseUrl;
  return config;
}

export default function ConfigForm() {
  const [draft, setDraft] = useState<ExperimentConfigV1Type>(() => cloneDraft(FORM_DEFAULTS));
  const [charterText, setCharterText] = useState(() => JSON.stringify(FORM_DEFAULTS.task.charter, null, 2));
  const [charterError, setCharterError] = useState<string | null>(null);
  const [fixtures, setFixtures] = useState<FixtureSummary[]>([]);
  const [envVars, setEnvVars] = useState<EnvVarStatus[]>([]);
  const [readSide, setReadSide] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<{ runId: string; logPath: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/fixtures")
      .then((res) => res.json())
      .then((data: { fixtures?: FixtureSummary[] }) => {
        if (!cancelled) setFixtures(data.fixtures ?? []);
      })
      .catch(() => {
        // The Scenario section just shows an empty fixture list; Run stays validated as usual.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const memberCount = draft.fleet.members.length;
  const providersKey = draft.fleet.members.map((m) => m.provider).join(",");
  const targetKind = draft.target.kind;
  useEffect(() => {
    let cancelled = false;
    const anyOpenRouter = providersKey.split(",").includes("openrouter");
    const qs = new URLSearchParams({ n: String(memberCount), openrouter: anyOpenRouter ? "1" : "0", target: targetKind });
    fetch(`/api/env?${qs.toString()}`)
      .then((res) => res.json())
      .then((data: { vars?: EnvVarStatus[] }) => {
        if (!cancelled) setEnvVars(data.vars ?? []);
      })
      .catch(() => {
        // The key section just shows nothing until the next successful fetch.
      });
    return () => {
      cancelled = true;
    };
  }, [memberCount, providersKey, targetKind]);

  const validation = useMemo(() => ExperimentConfigV1.safeParse(draft), [draft]);
  const nameError = EXPERIMENT_NAME_PATTERN.test(draft.name) ? null : "name must match ^[a-z0-9][a-z0-9-]{0,39}$";
  const fieldErrors = useMemo(() => {
    const map: Record<string, string> = {};
    if (!validation.success) {
      for (const issue of validation.error.issues) map[issue.path.join(".")] = issue.message;
    }
    if (nameError) map["name"] = nameError;
    if (charterError) map["task.charter"] = charterError;
    return map;
  }, [validation, nameError, charterError]);
  const canSubmit = Object.keys(fieldErrors).length === 0 && !submitting;

  const yesCount = effectiveYesCount(memberCount, draft.governance.quorumNumerator);
  const yesCountBad = yesCount > memberCount || yesCount < 2;

  function updateMember(index: number, patch: Partial<FleetMember>): void {
    setDraft((prev) => ({
      ...prev,
      fleet: { ...prev.fleet, members: prev.fleet.members.map((m, i) => (i === index ? { ...m, ...patch } : m)) },
    }));
  }

  function addMember(): void {
    setDraft((prev) => ({ ...prev, fleet: { ...prev.fleet, members: [...prev.fleet.members, defaultMember("")] } }));
  }

  function removeMember(index: number): void {
    setDraft((prev) => ({ ...prev, fleet: { ...prev.fleet, members: prev.fleet.members.filter((_, i) => i !== index) } }));
  }

  function setFleetSize(rawValue: number): void {
    const size = Math.max(2, Math.min(64, Number.isFinite(rawValue) ? Math.trunc(rawValue) : 2));
    setDraft((prev) => {
      const current = prev.fleet.members;
      let members = current;
      if (size > current.length) {
        members = [...current, ...Array.from({ length: size - current.length }, () => defaultMember(""))];
      } else if (size < current.length) {
        members = current.slice(0, size);
      }
      return { ...prev, fleet: { ...prev.fleet, members } };
    });
  }

  function handleFixtureChange(name: string): void {
    const fixture = fixtures.find((f) => f.name === name);
    const isModel = fixture?.kind === "model";
    const agentsScripted = fixture ? !isModel : draft.scenario.agentsScripted;

    // A scripted fixture names no charter of its own, so it always pre-fills from the embedded
    // default. A model fixture pre-fills from its own charter (GET /api/fixtures reads and
    // CharterV1-validates it server-side, per its charterPath), never from the default: falling
    // back to CODING_TASK_CHARTER here would silently apply the wrong charter for a fixture like
    // legit-amendment or escalate, whose charter differs from coding-task.v1.json (fix round 1).
    // If that fixture's own charter failed to load server-side, keep whatever charter is already
    // in the editor rather than guess, and surface why via the same inline error the textarea uses.
    let charter = CODING_TASK_CHARTER;
    let charterLoadError: string | null = null;
    if (isModel && fixture) {
      if (fixture.charter) {
        charter = fixture.charter;
      } else {
        charter = draft.task.charter;
        charterLoadError = fixture.charterError ?? `could not load the charter for fixture "${name}"`;
      }
    }

    setDraft((prev) => ({ ...prev, scenario: { fixture: name, agentsScripted }, task: { ...prev.task, charter } }));
    setCharterText(JSON.stringify(charter, null, 2));
    setCharterError(charterLoadError);
  }

  function handleCharterTextChange(text: string): void {
    setCharterText(text);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      setCharterError("charter must be valid JSON");
      return;
    }
    const result = CharterV1.safeParse(json);
    if (!result.success) {
      setCharterError(result.error.issues[0]?.message ?? "invalid charter");
      return;
    }
    setCharterError(null);
    setDraft((prev) => ({ ...prev, task: { ...prev.task, charter: result.data } }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitResult(null);
    try {
      const config = buildSubmissionConfig(draft);
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, readSide }),
      });
      const data = (await res.json()) as { runId?: string; logPath?: string; error?: string };
      if (res.ok && data.runId && data.logPath) {
        setSubmitResult({ runId: data.runId, logPath: data.logPath });
      } else {
        setSubmitError(data.error ?? `run could not be started (HTTP ${res.status})`);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const fixtureOptions = fixtures.some((f) => f.name === draft.scenario.fixture)
    ? fixtures
    : [{ name: draft.scenario.fixture, kind: draft.scenario.agentsScripted ? ("scripted" as const) : ("model" as const), description: "" }, ...fixtures];

  return (
    <form onSubmit={handleSubmit}>
      <section>
        <h2>Target</h2>
        <label htmlFor="experiment-name">Experiment name</label>
        <input id="experiment-name" value={draft.name} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} />
        {fieldErrors["name"] && <p role="alert">{fieldErrors["name"]}</p>}

        <fieldset>
          <legend>Target chain</legend>
          <label>
            <input
              type="radio"
              name="target-kind"
              value="local-anvil"
              checked={draft.target.kind === "local-anvil"}
              onChange={() => setDraft((prev) => ({ ...prev, target: { ...prev.target, kind: "local-anvil" } }))}
            />
            local-anvil
          </label>
          <label>
            <input
              type="radio"
              name="target-kind"
              value="base-sepolia"
              checked={draft.target.kind === "base-sepolia"}
              onChange={() => setDraft((prev) => ({ ...prev, target: { ...prev.target, kind: "base-sepolia" } }))}
            />
            base-sepolia
          </label>
        </fieldset>

        <label htmlFor="rpc-http">RPC HTTP URL</label>
        <input
          id="rpc-http"
          value={draft.target.rpcHttp}
          onChange={(e) => setDraft((prev) => ({ ...prev, target: { ...prev.target, rpcHttp: e.target.value } }))}
        />
        {fieldErrors["target.rpcHttp"] && <p role="alert">{fieldErrors["target.rpcHttp"]}</p>}

        <label htmlFor="rpc-ws">RPC WS URL</label>
        <input
          id="rpc-ws"
          value={draft.target.rpcWs}
          onChange={(e) => setDraft((prev) => ({ ...prev, target: { ...prev.target, rpcWs: e.target.value } }))}
        />
        {fieldErrors["target.rpcWs"] && <p role="alert">{fieldErrors["target.rpcWs"]}</p>}

        <h3>Keys (by environment variable name)</h3>
        <ul>
          {envVars.map((v) => (
            <li key={v.name}>
              {v.name}: {v.source === "local-anvil-test-key" ? "using the local Anvil test key" : v.present ? "present" : "missing"}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Fleet</h2>
        <label htmlFor="fleet-size">Fleet size (N)</label>
        <input
          id="fleet-size"
          type="number"
          min={2}
          max={64}
          value={memberCount}
          onChange={(e) => setFleetSize(Number(e.target.value))}
        />

        <label htmlFor="token-name">Token name</label>
        <input
          id="token-name"
          value={draft.fleet.tokenName}
          onChange={(e) => setDraft((prev) => ({ ...prev, fleet: { ...prev.fleet, tokenName: e.target.value } }))}
        />

        <label htmlFor="token-symbol">Token symbol</label>
        <input
          id="token-symbol"
          value={draft.fleet.tokenSymbol}
          onChange={(e) => setDraft((prev) => ({ ...prev, fleet: { ...prev.fleet, tokenSymbol: e.target.value } }))}
        />

        {draft.fleet.members.map((member, index) => (
          <div key={index}>
            <label htmlFor={`member-role-${index}`}>Role</label>
            <input id={`member-role-${index}`} value={member.role} onChange={(e) => updateMember(index, { role: e.target.value })} />

            <label htmlFor={`member-provider-${index}`}>Provider</label>
            <select
              id={`member-provider-${index}`}
              value={member.provider}
              onChange={(e) => updateMember(index, { provider: e.target.value as FleetMember["provider"] })}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <label htmlFor={`member-model-${index}`}>Model</label>
            <input id={`member-model-${index}`} value={member.model} onChange={(e) => updateMember(index, { model: e.target.value })} />

            <label htmlFor={`member-prompt-${index}`}>Prompt version</label>
            <input
              id={`member-prompt-${index}`}
              value={member.promptVersion}
              onChange={(e) => updateMember(index, { promptVersion: e.target.value })}
            />

            <label htmlFor={`member-operator-${index}`}>Operator label</label>
            <input
              id={`member-operator-${index}`}
              value={member.operatorLabel}
              onChange={(e) => updateMember(index, { operatorLabel: e.target.value })}
            />

            {draft.fleet.members.length > 2 && (
              <button type="button" onClick={() => removeMember(index)}>
                Remove member {index}
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={addMember} disabled={draft.fleet.members.length >= 64}>
          Add member
        </button>
      </section>

      <section>
        <h2>Governance</h2>
        <label htmlFor="voting-delay">Voting delay (seconds)</label>
        <input
          id="voting-delay"
          type="number"
          value={draft.governance.votingDelay}
          onChange={(e) => setDraft((prev) => ({ ...prev, governance: { ...prev.governance, votingDelay: Number(e.target.value) } }))}
        />

        <label htmlFor="voting-period">Voting period (seconds)</label>
        <input
          id="voting-period"
          type="number"
          value={draft.governance.votingPeriod}
          onChange={(e) => setDraft((prev) => ({ ...prev, governance: { ...prev.governance, votingPeriod: Number(e.target.value) } }))}
        />

        <label htmlFor="timelock-delay">Timelock delay (seconds)</label>
        <input
          id="timelock-delay"
          type="number"
          value={draft.governance.timelockDelay}
          onChange={(e) => setDraft((prev) => ({ ...prev, governance: { ...prev.governance, timelockDelay: Number(e.target.value) } }))}
        />

        <label htmlFor="quorum-numerator">Quorum numerator (basis points out of 10000)</label>
        <input
          id="quorum-numerator"
          type="number"
          value={draft.governance.quorumNumerator}
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, governance: { ...prev.governance, quorumNumerator: Number(e.target.value) } }))
          }
        />

        <label htmlFor="proposal-threshold">Proposal threshold (wei, decimal string)</label>
        <input
          id="proposal-threshold"
          value={draft.governance.proposalThreshold}
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, governance: { ...prev.governance, proposalThreshold: e.target.value } }))
          }
        />

        <label htmlFor="max-task-lifetime">Max task lifetime (seconds)</label>
        <input
          id="max-task-lifetime"
          type="number"
          value={draft.governance.maxTaskLifetime}
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, governance: { ...prev.governance, maxTaskLifetime: Number(e.target.value) } }))
          }
        />

        <p style={yesCountBad ? { color: "red" } : undefined}>
          effective yes count: {yesCount} of {memberCount}
        </p>
      </section>

      <section>
        <h2>Task</h2>
        <label htmlFor="charter-editor">Charter (JSON)</label>
        <textarea id="charter-editor" value={charterText} onChange={(e) => handleCharterTextChange(e.target.value)} rows={12} />
        {fieldErrors["task.charter"] && <p role="alert">{fieldErrors["task.charter"]}</p>}

        <label htmlFor="task-lifetime">Task lifetime (seconds)</label>
        <input
          id="task-lifetime"
          type="number"
          value={draft.task.lifetime}
          onChange={(e) => setDraft((prev) => ({ ...prev, task: { ...prev.task, lifetime: Number(e.target.value) } }))}
        />

        <label htmlFor="repo-fixture">Repository fixture</label>
        <input
          id="repo-fixture"
          value={draft.task.repoFixture}
          onChange={(e) => setDraft((prev) => ({ ...prev, task: { ...prev.task, repoFixture: e.target.value } }))}
        />
      </section>

      <section>
        <h2>Scenario</h2>
        <label htmlFor="scenario-fixture">Scenario fixture</label>
        <select id="scenario-fixture" value={draft.scenario.fixture} onChange={(e) => handleFixtureChange(e.target.value)}>
          {fixtureOptions.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name} ({f.kind})
            </option>
          ))}
        </select>

        <label htmlFor="scenario-scripted">
          <input
            id="scenario-scripted"
            type="checkbox"
            checked={draft.scenario.agentsScripted}
            onChange={(e) => setDraft((prev) => ({ ...prev, scenario: { ...prev.scenario, agentsScripted: e.target.checked } }))}
          />
          Scripted agents
        </label>
      </section>

      <section>
        <h2>Capture</h2>
        <label htmlFor="capture-bucket">GCS bucket (optional)</label>
        <input
          id="capture-bucket"
          value={draft.capture.gcsBucket ?? ""}
          onChange={(e) => setDraft((prev) => ({ ...prev, capture: { ...prev.capture, gcsBucket: e.target.value } }))}
        />

        <label htmlFor="capture-report-dir">Report directory</label>
        <input
          id="capture-report-dir"
          value={draft.capture.reportDir}
          onChange={(e) => setDraft((prev) => ({ ...prev, capture: { ...prev.capture, reportDir: e.target.value } }))}
        />
      </section>

      <section>
        <h2>Display</h2>
        <label htmlFor="agora-next-base-url">Agora Next base URL (optional)</label>
        <input
          id="agora-next-base-url"
          value={draft.display.agoraNextBaseUrl ?? ""}
          onChange={(e) => setDraft((prev) => ({ ...prev, display: { ...prev.display, agoraNextBaseUrl: e.target.value } }))}
        />
        {fieldErrors["display.agoraNextBaseUrl"] && <p role="alert">{fieldErrors["display.agoraNextBaseUrl"]}</p>}
      </section>

      <section>
        <label htmlFor="read-side">
          <input id="read-side" type="checkbox" checked={readSide} onChange={(e) => setReadSide(e.target.checked)} />
          Bring up the read side before running
        </label>
        <button type="submit" disabled={!canSubmit}>
          Run
        </button>
        {submitError && <p role="alert">{submitError}</p>}
        {submitResult && (
          <p>
            Run started: {submitResult.runId} (log: {submitResult.logPath})
          </p>
        )}
      </section>
    </form>
  );
}
