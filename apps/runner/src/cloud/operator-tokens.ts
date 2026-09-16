import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { OperatorEmail } from "./operators.js";
import { protectedRecord, putProtected, deleteProtected } from "./protected-records.js";
import { googleRequest } from "./google.js";

// Separate bucket: worker, Guardian and preparation identities cannot read it.
export const AUTH_BUCKET = "fleet-governance-operator-auth-449245570324";
const TokenRecord = z.object({ schema: z.literal("fleet.mcp-token.v1"), requestedBy: OperatorEmail,
  label: z.string().min(1).max(80), createdAt: z.string().datetime(), expiresAt: z.string().datetime() }).strict();
export const TokenInput = z.object({ label: z.string().trim().min(1).max(80), hours: z.number().int().min(1).max(24).default(12) }).strict();
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const path = (id: string) => `tokens/${z.string().regex(/^[a-f0-9]{64}$/).parse(id)}.json`;
export async function issueOperatorToken(requestedBy: OperatorEmail, input: unknown) {
  OperatorEmail.parse(requestedBy);
  const settings = TokenInput.parse(input);
  if ((await listOperatorTokens(requestedBy)).filter(item => Date.parse(item.expiresAt) > Date.now()).length >= 10) throw new Error("Revoke an existing credential before creating another.");
  const token = `fleet_mcp_${randomBytes(32).toString("base64url")}`;
  const value = TokenRecord.parse({ schema: "fleet.mcp-token.v1", requestedBy, label: settings.label, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + settings.hours * 3600_000).toISOString() });
  await putProtected(path(hash(token)), value, "0", AUTH_BUCKET);
  return { id: hash(token), token, ...value };
}
export async function authenticateOperatorToken(authorization: string | undefined): Promise<OperatorEmail | null> {
  const match = /^Bearer (fleet_mcp_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match) return null;
  const stored = await protectedRecord(path(hash(match[1]!)), AUTH_BUCKET);
  const parsed = TokenRecord.safeParse(stored?.value);
  if (!parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) return null;
  return parsed.data.requestedBy;
}
export async function listOperatorTokens(requestedBy: OperatorEmail) {
  OperatorEmail.parse(requestedBy);
  const records: ({ id: string } & z.infer<typeof TokenRecord>)[] = [];
  let pageToken = "";
  do {
    const page = await (await googleRequest("storage", `storage/v1/b/${AUTH_BUCKET}/o?prefix=tokens%2F&fields=items(name),nextPageToken&maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`)).json() as { items?: { name: string }[]; nextPageToken?: string };
    for (const item of page.items ?? []) {
      const parsed = TokenRecord.safeParse((await protectedRecord(item.name, AUTH_BUCKET))?.value);
      if (parsed.success && parsed.data.requestedBy === requestedBy) records.push({ id: item.name.slice(7, -5), ...parsed.data });
    }
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return records;
}
export async function revokeOperatorToken(requestedBy: OperatorEmail, id: string) {
  const stored = await protectedRecord(path(id), AUTH_BUCKET);
  if (!stored) return;
  if (TokenRecord.parse(stored.value).requestedBy !== OperatorEmail.parse(requestedBy)) throw new Error("This credential belongs to another operator.");
  await deleteProtected(path(id), stored.generation, AUTH_BUCKET);
}
