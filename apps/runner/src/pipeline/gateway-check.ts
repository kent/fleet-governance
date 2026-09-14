import { LedgerWatcher, describeAction, evaluateAction } from "@fleet/gateway";
import type { GatewayLogRecord, GatewayVerdict } from "@fleet/gateway";
import type { FleetClient } from "@fleet/sdk";
import type { ActionClass } from "@fleet/schemas";

/**
 * Evaluates one tool call against a task's live ledger state and shapes the result as a
 * `GatewayLogRecord` (spec 8, "Gateway allow and block log"), the same record shape `record.json`
 * carries under `gatewayLog[]`. `agentId` is caller-supplied context only (the gateway itself
 * never looks at who is asking); `0` is used for fixture-level, not-agent-specific checks.
 */
export async function checkGateway(
  client: FleetClient,
  taskId: bigint,
  agentId: number,
  action: { class: ActionClass; target: string; args?: unknown },
): Promise<{ verdict: GatewayVerdict; record: GatewayLogRecord }> {
  const watcher = new LedgerWatcher(client, taskId, () => {
    // LedgerWatcher already fails closed (paused: true) and never throws; nothing more to log here.
  });
  const snapshot = await watcher.snapshot();
  // Reconstructed rather than passed through directly: `action.args` may come from a type where
  // the `args` key itself is optional (`@fleet/schemas`'s `FixtureAction`); building a fresh
  // literal here always has the key present, matching `describeAction`'s required `args: unknown`
  // under this project's `exactOptionalPropertyTypes`.
  const descriptor = describeAction({ class: action.class, target: action.target, args: action.args });
  const verdict = await evaluateAction(snapshot, descriptor, { toolCalls: 0 });

  const record: GatewayLogRecord = {
    ts: new Date().toISOString(),
    blockNumber: snapshot.blockNumber.toString(),
    taskId: taskId.toString(),
    agentId,
    charterVersion: snapshot.charterVersion,
    descriptor,
    payloadHash: verdict.payloadHash,
    verdict: verdict.verdict,
    ...(verdict.verdict === "BLOCK" ? { reason: verdict.reason } : {}),
    ...(verdict.verdict === "ALLOW" ? { basis: verdict.basis } : {}),
  };

  return { verdict, record };
}
