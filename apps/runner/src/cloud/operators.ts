import { z } from "zod";
import type { IncomingHttpHeaders } from "node:http";

/** Identities come from private deployment configuration, never source or defaults.
 * Read on validation so removing an operator invalidates their next request. */
export function operatorEmails(): string[] {
  try {
    const parsed = z.array(z.string().email()).length(5).safeParse(JSON.parse(process.env.FLEET_OPERATOR_EMAILS_JSON ?? "null"));
    return parsed.success && new Set(parsed.data).size === 5 ? parsed.data : [];
  } catch { return []; }
}
export const OperatorEmail = z.string().email().refine(email => operatorEmails().includes(email), "An authorised operator is required.");
export type OperatorEmail = z.infer<typeof OperatorEmail>;
export function operatorIdentity(headers: IncomingHttpHeaders): OperatorEmail | null {
  const value = headers["x-goog-authenticated-user-email"];
  if (typeof value !== "string" || !value.startsWith("accounts.google.com:")) return null;
  const parsed = OperatorEmail.safeParse(value.slice("accounts.google.com:".length));
  return parsed.success ? parsed.data : null;
}
