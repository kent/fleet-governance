// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AgentPanel from "./AgentPanel.js";
import type { AgentPanelProps } from "./AgentPanel.js";

afterEach(() => cleanup());

function fullProps(): AgentPanelProps {
  return {
    agentId: 2,
    address: "0xccc0000000000000000000000000000000000c",
    role: "critic",
    provider: "openrouter",
    model: "meta/muse-spark-1.3-contributor",
    promptVersion: "3",
    lastStep: {
      type: "step",
      at: "2026-09-14T00:00:00.000Z",
      agentId: 2,
      seq: 4,
      tool: { class: "read_repo", target: "src/index.ts", args: {} },
      why: "checking the current implementation before proposing a fix",
      source: "model",
    },
    lastGatewayDecision: {
      ts: "2026-09-14T00:00:01.000Z",
      blockNumber: "100",
      taskId: "1",
      agentId: 2,
      charterVersion: 1,
      descriptor: { class: "network_fetch", target: "registry.npmjs.org", argsHash: `0x${"aa".repeat(32)}` },
      payloadHash: `0x${"bb".repeat(32)}`,
      verdict: "BLOCK",
      reason: "host not in externalAllowlist",
      basis: "charter v1",
    },
    jobState: "SUBMIT",
  };
}

describe("AgentPanel", () => {
  it("renders role, provider, model, step, and gateway decision when everything is known", () => {
    render(<AgentPanel {...fullProps()} />);
    expect(screen.getByText(/critic/).textContent).toContain("critic");
    expect(screen.getByLabelText("Last step").textContent).toContain("checking the current implementation before proposing a fix");
    expect(screen.getByLabelText("Last gateway decision").textContent).toContain("BLOCK");
    expect(screen.getByLabelText("Last gateway decision").textContent).toContain("host not in externalAllowlist");
    expect(screen.getByText(/SUBMIT/)).toBeTruthy();
  });

  it("falls back to unknown/no-data-yet text for every field when nothing is known", () => {
    render(
      <AgentPanel
        agentId={4}
        address={null}
        role={null}
        provider={null}
        model={null}
        promptVersion={null}
        lastStep={null}
        lastGatewayDecision={null}
        jobState="not tracked (no database)"
      />,
    );
    expect(screen.getByLabelText("Last step").textContent).toContain("no step yet");
    expect(screen.getByLabelText("Last gateway decision").textContent).toContain("no gateway decision yet");
    expect(screen.getByText(/not tracked \(no database\)/)).toBeTruthy();
    const article = screen.getByText("Agent 4").closest("article");
    expect(article?.textContent).toContain("unknown");
  });
});
