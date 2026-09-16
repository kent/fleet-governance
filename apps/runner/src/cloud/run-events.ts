import { randomUUID } from "node:crypto";

/** An event is a receipt from its producer, not proof from a different subsystem.
 * The public reader assigns trust from the storage source rather than accepting a
 * worker-controlled assertion that it is the Guardian or GCP. */
export type RunEvent = {
  id: string; runId: string; at: string;
  component: "task" | "agents" | "governance" | "compute";
  type: string; title: string; detail: string;
  agentId?: number; checkpoint?: number; proposalId?: string;
  txHash?: string; blockNumber?: string; evidence?: unknown;
};
export function runEvent(runId: string, event: Omit<RunEvent, "id" | "runId" | "at">): RunEvent {
  return { ...event, id: randomUUID(), runId, at: new Date().toISOString() };
}
