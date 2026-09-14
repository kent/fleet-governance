import { z } from "zod";

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_STRING_PATTERN = /^(0|[1-9][0-9]*)$/;
const HOST_PATTERN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

/**
 * A 20-byte EVM address: "0x" followed by 40 hex digits. The regex matches
 * case-insensitively, and parsing normalizes the result to lowercase.
 *
 * Normalization happens here, at the schema boundary, rather than in each
 * caller, because every Agora tool downstream of this package (the SDK,
 * the gateway, the keeper, the indexers) compares addresses as lowercase
 * strings. Doing it once on parse means every consumer can rely on plain
 * string equality instead of re-normalizing before every comparison.
 */
export const Address = z
  .string()
  .regex(ADDRESS_PATTERN, "must be a 0x-prefixed 40 hex digit address")
  .transform((value) => value.toLowerCase());
export type Address = z.infer<typeof Address>;

/** A 32-byte hash or salt: "0x" followed by 64 hex digits. */
export const Hex32 = z.string().regex(HEX32_PATTERN, "must be a 0x-prefixed 64 hex digit value");
export type Hex32 = z.infer<typeof Hex32>;

/**
 * A non-negative decimal integer with no leading zeros, carried as a
 * string so uint256 values (proposal thresholds, task ids, proposal ids)
 * survive JSON round trips without losing precision.
 */
export const DecimalString = z
  .string()
  .regex(DECIMAL_STRING_PATTERN, "must be a non-negative decimal integer string with no leading zeros");
export type DecimalString = z.infer<typeof DecimalString>;

/** A bare hostname: no scheme, no path, no port, no credentials. */
export const Host = z
  .string()
  .min(1)
  .max(253)
  .regex(HOST_PATTERN, "must be a bare hostname with no scheme, path, or port");
export type Host = z.infer<typeof Host>;
