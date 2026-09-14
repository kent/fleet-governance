// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Timeline, { mergeTimelineItems } from "./Timeline.js";
import type { TimelineChainEvent } from "./Timeline.js";
import type { GatewayLogLineType, InterventionLineType } from "../pipeline/runfiles.js";

afterEach(() => cleanup());

const HASH = (n: number) => `0x${n.toString().padStart(64, "0")}`;

function chainEvent(overrides: Partial<TimelineChainEvent>): TimelineChainEvent {
  return { type: "ProposalCreated", blockNumber: "10", logIndex: 0, txHash: HASH(1), ...overrides };
}

function gatewayRecord(overrides: Partial<GatewayLogLineType>): GatewayLogLineType {
  return {
    ts: "2026-09-14T00:00:00.000Z",
    blockNumber: "10",
    taskId: "1",
    agentId: 0,
    charterVersion: 1,
    descriptor: { class: "read_repo", target: "README.md", argsHash: HASH(2) },
    payloadHash: HASH(3),
    verdict: "ALLOW",
    ...overrides,
  };
}

function intervention(overrides: Partial<InterventionLineType>): InterventionLineType {
  return {
    type: "human_intervention",
    at: "2026-09-14T00:00:00.000Z",
    action: "pause",
    proposalId: null,
    txHash: HASH(4),
    blockNumber: "10",
    actor: "guardian",
    ...overrides,
  };
}

describe("mergeTimelineItems", () => {
  it("orders chain events by (blockNumber, logIndex)", () => {
    const items = mergeTimelineItems(
      [chainEvent({ blockNumber: "12", logIndex: 1, txHash: HASH(1) }), chainEvent({ blockNumber: "10", logIndex: 0, txHash: HASH(2) }), chainEvent({ blockNumber: "10", logIndex: 5, txHash: HASH(3) })],
      [],
      [],
    );
    expect(items.map((i) => (i.register === "onchain" ? i.event.txHash : null))).toEqual([HASH(2), HASH(3), HASH(1)]);
  });

  it("orders gateway records by blockNumber then at, and places them after chain events in the same block", () => {
    const items = mergeTimelineItems(
      [chainEvent({ blockNumber: "20", logIndex: 0, txHash: HASH(9) })],
      [gatewayRecord({ blockNumber: "20", ts: "2026-09-14T00:00:02.000Z" }), gatewayRecord({ blockNumber: "20", ts: "2026-09-14T00:00:01.000Z" })],
      [],
    );
    expect(items.map((i) => i.register)).toEqual(["onchain", "gateway", "gateway"]);
    expect(items[1]?.register === "gateway" ? items[1].record.ts : null).toBe("2026-09-14T00:00:01.000Z");
    expect(items[2]?.register === "gateway" ? items[2].record.ts : null).toBe("2026-09-14T00:00:02.000Z");
  });

  it("orders interventions by blockNumber, after chain events and gateway records in the same block", () => {
    const items = mergeTimelineItems(
      [chainEvent({ blockNumber: "5", logIndex: 0 })],
      [gatewayRecord({ blockNumber: "5" })],
      [intervention({ blockNumber: "5" }), intervention({ blockNumber: "3" })],
    );
    expect(items.map((i) => i.register)).toEqual(["human-intervention", "onchain", "gateway", "human-intervention"]);
  });
});

describe("Timeline", () => {
  it("renders a labeled entry per register, in merged order", () => {
    render(
      <Timeline
        chainEvents={[chainEvent({ type: "VoteCast", blockNumber: "10", logIndex: 0, txHash: HASH(1) })]}
        gatewayRecords={[gatewayRecord({ blockNumber: "11", verdict: "BLOCK", reason: "not allowlisted" })]}
        interventions={[intervention({ blockNumber: "12", action: "cancel", proposalId: "42" })]}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain("Onchain");
    expect(items[0]?.textContent).toContain("VoteCast");
    expect(items[1]?.textContent).toContain("Gateway decision");
    expect(items[1]?.textContent).toContain("BLOCK");
    expect(items[1]?.textContent).toContain("not allowlisted");
    expect(items[2]?.textContent).toContain("Human intervention");
    expect(items[2]?.textContent).toContain("cancel");
    expect(items[2]?.textContent).toContain("42");
  });

  it("renders a fallback message with no events", () => {
    render(<Timeline chainEvents={[]} gatewayRecords={[]} interventions={[]} />);
    expect(screen.getByText(/no timeline events yet/i)).toBeTruthy();
  });
});
