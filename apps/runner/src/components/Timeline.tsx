"use client";

import type { GatewayLogLineType, InterventionLineType } from "../pipeline/runfiles.js";
import { useCollectionPage } from "./useCollectionPage.js";

/** A `DecisionTraceEvent` (or a `record.json` chain event), every `bigint` already a decimal
 *  string (matches `src/lib/run-state.ts`'s `ChainEventView`, duck-typed here rather than imported
 *  so this component never pulls in that module's server-only dependencies). */
export type TimelineChainEvent = Record<string, unknown> & { type: string; blockNumber: string; logIndex: number; txHash: string };

export type TimelineProps = {
  chainEvents: readonly TimelineChainEvent[];
  gatewayRecords: readonly GatewayLogLineType[];
  interventions: readonly InterventionLineType[];
};

type Register = "onchain" | "gateway" | "human-intervention";

export type TimelineItem =
  | { key: string; register: "onchain"; blockNumber: bigint; event: TimelineChainEvent }
  | { key: string; register: "gateway"; blockNumber: bigint; record: GatewayLogLineType }
  | { key: string; register: "human-intervention"; blockNumber: bigint; record: InterventionLineType };

const REGISTER_RANK: Record<Register, number> = { onchain: 0, gateway: 1, "human-intervention": 2 };

/**
 * Merges chain events, gateway decisions, and guardian interventions into one ordered list (task 6
 * controller notes: "`Timeline` orders by `(blockNumber, logIndex)` for chain events, by
 * `blockNumber` then `at` for gateway records, interventions by `blockNumber`"). Exported
 * separately from the component so ordering is unit-testable without rendering.
 */
export function mergeTimelineItems(
  chainEvents: readonly TimelineChainEvent[],
  gatewayRecords: readonly GatewayLogLineType[],
  interventions: readonly InterventionLineType[],
): TimelineItem[] {
  const chainItems: TimelineItem[] = chainEvents
    .map((event, i) => ({ key: `chain-${i}-${event.txHash}-${event.logIndex}`, register: "onchain" as const, blockNumber: BigInt(event.blockNumber), event }))
    .sort((a, b) => (a.event as TimelineChainEvent).logIndex - (b.event as TimelineChainEvent).logIndex);

  const gatewayItems: TimelineItem[] = gatewayRecords
    .map((record, i) => ({ key: `gateway-${i}`, register: "gateway" as const, blockNumber: BigInt(record.blockNumber), record }))
    .sort((a, b) => (a.record as GatewayLogLineType).ts.localeCompare((b.record as GatewayLogLineType).ts));

  const interventionItems: TimelineItem[] = interventions
    .map((record, i) => ({ key: `intervention-${i}`, register: "human-intervention" as const, blockNumber: BigInt(record.blockNumber), record }))
    .sort((a, b) => (a.record as InterventionLineType).at.localeCompare((b.record as InterventionLineType).at));

  return [...chainItems, ...gatewayItems, ...interventionItems].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return REGISTER_RANK[a.register] - REGISTER_RANK[b.register];
  });
}

/**
 * The live run view's timeline (spec 12.3): chain events, gateway allow/block decisions, and
 * guardian interventions interleaved by block. Every register is labeled so an onchain fact is
 * never confused with agent-authored text or a human intervention (spec 11.4, Decision trace).
 */
export default function Timeline({ chainEvents, gatewayRecords, interventions }: TimelineProps) {
  const items = mergeTimelineItems(chainEvents, gatewayRecords, interventions);
  const page = useCollectionPage(items, "events", item => Object.values(item.register === "onchain" ? item.event : item.record)
    .filter(value => typeof value !== "object").map(String).join(" "));

  if (items.length === 0) {
    return <p>No timeline events yet.</p>;
  }

  return (
    <>
    {page.controls}
    <ol aria-label="Timeline">
      {page.visible.map((item) => (
        <li key={item.key} data-block={item.blockNumber.toString()} data-register={item.register}>
          <span>Block {item.blockNumber.toString()}</span>{" "}
          {item.register === "onchain" && (
            <span>
              <strong>Onchain:</strong> {item.event["type"] as string} (tx {truncateHash(item.event.txHash)})
            </span>
          )}
          {item.register === "gateway" && (
            <span>
              <strong>Gateway decision:</strong> {item.record.verdict} for agent {item.record.agentId} (
              {item.record.descriptor.class} {item.record.descriptor.target})
              {item.record.reason ? `, reason: ${item.record.reason}` : ""}
            </span>
          )}
          {item.register === "human-intervention" && (
            <span>
              <strong>Human intervention:</strong> guardian {item.record.action}
              {item.record.proposalId ? ` (proposal ${item.record.proposalId})` : ""} (tx {truncateHash(item.record.txHash)})
            </span>
          )}
        </li>
      ))}
    </ol>
    </>
  );
}

function truncateHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 10)}…` : hash;
}
