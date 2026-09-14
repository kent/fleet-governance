import { z } from "zod";
import { Address, DecimalString, Hex32 } from "./primitives.js";

const boundedInteger = (bits: number, digits: number) => DecimalString.max(digits).refine(value =>
  /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < (1n << BigInt(bits)), `must fit uint${bits}`);

/** Exact contract capability shown publicly in a GRANT_EXCEPTION proposal. No ETH value,
 * arbitrary signature, delegatecall, or ambient operator credential is part of this permission. */
export const ExecutionPermitV1 = z.object({
  schema: z.literal("fleet.execution-permit.v1"),
  chainId: z.number().int().positive().safe(),
  executor: Address,
  ledger: Address,
  taskId: boundedInteger(256, 78).refine(value => value !== "0", "taskId must be positive"),
  charterVersion: z.number().int().positive().max(0xffffffff),
  actor: Address,
  target: Address,
  targetCodeHash: Hex32,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){4,8192}$/, "must contain 4..8192 bytes of calldata"),
  nonce: boundedInteger(256, 78),
  deadline: boundedInteger(64, 20),
}).strict();
export type ExecutionPermitV1 = z.infer<typeof ExecutionPermitV1>;
