import { keccak256, toHex } from "viem";
import { ActionDescriptor, canonicalize } from "@fleet/schemas";
import type { ActionClass } from "@fleet/schemas";

/**
 * Builds an `ActionDescriptor` for one tool call. `args` is never inspected for meaning: it is
 * canonicalized and hashed, the same way any other data the gateway reads is data, never an
 * instruction. Text inside `args` (a filename, a fetched page, a model's own scratch note) cannot
 * change the resulting descriptor's shape, only its opaque `argsHash`.
 */
export function describeAction(input: { class: ActionClass; target: string; args: unknown }): ActionDescriptor {
  const argsHash = keccak256(toHex(canonicalize(input.args)));
  return ActionDescriptor.parse({ class: input.class, target: input.target, argsHash });
}
