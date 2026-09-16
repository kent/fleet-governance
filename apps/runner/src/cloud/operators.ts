import { z } from "zod";
import type { IncomingHttpHeaders } from "node:http";

/** The same human allowlist applies to browser grants, MCP and batch manifests. */
export const OPERATOR_EMAILS = ["operator1@example.com", "operator2@example.com", "operator3@example.com", "operator4@example.com", "operator5@example.com"] as const;
export const OperatorEmail = z.enum(OPERATOR_EMAILS);
export type OperatorEmail = z.infer<typeof OperatorEmail>;
export function operatorIdentity(headers: IncomingHttpHeaders): OperatorEmail | null {
  const value = headers["x-goog-authenticated-user-email"];
  if (typeof value !== "string" || !value.startsWith("accounts.google.com:")) return null;
  const parsed = OperatorEmail.safeParse(value.slice("accounts.google.com:".length));
  return parsed.success ? parsed.data : null;
}
