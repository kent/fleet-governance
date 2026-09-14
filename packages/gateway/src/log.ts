import type { Hex } from "viem";
import type { ActionDescriptor } from "@fleet/schemas";
import type { GatewayVerdict } from "./evaluate.js";

/**
 * One gateway allow/block decision, shaped for the experiment record (spec 8, "Gateway allow and
 * block log"). `blockNumber` and `taskId` are decimal strings, not `bigint`, so a record survives
 * a JSON round trip without a custom serializer, matching `DecimalString` elsewhere in this repo.
 *
 * This package does not write these records anywhere itself: the caller builds one from a
 * `LedgerSnapshot`, an `ActionDescriptor`, an `evaluateAction` result, and its own `agentId`, and
 * passes it to whatever sink it owns (a file, a database, the Runner's report). Keeping the sink
 * out of this package is deliberate: the gateway is offchain policy, not a logging service, and a
 * caller-supplied sink function is what "the log sink is a function passed by the caller" means.
 */
export type GatewayLogRecord = {
  ts: string;
  blockNumber: string;
  taskId: string;
  agentId: number;
  charterVersion: number;
  descriptor: ActionDescriptor;
  payloadHash: Hex;
  verdict: GatewayVerdict["verdict"];
  reason?: string;
  basis?: string;
};
