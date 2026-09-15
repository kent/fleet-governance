import type { IncomingHttpHeaders } from "node:http";

const operators = new Set([
  "accounts.google.com:operator2@example.com",
  "accounts.google.com:fleet-provisioner@fleet-governance.iam.gserviceaccount.com",
]);
export type SiteAccess = "public" | "operator";
export function siteAccess(value: string | undefined): SiteAccess {
  // An omitted or misspelled deployment setting must never grant public access.
  if (value !== "public" && value !== "operator") throw new Error("FLEET_SITE_ACCESS must be public or operator.");
  return value;
}
export function authorisedRequest(access: SiteAccess, method: string, headers: IncomingHttpHeaders): boolean {
  if (access === "public") return method === "GET" || method === "HEAD";
  // Operator service accepts traffic only through IAP, with Cloud Run IAM enabled.
  // Public mode never trusts this client-spoofable header, even for known users.
  if (!operators.has(String(headers["x-goog-authenticated-user-email"]))) return false;
  return ["GET", "HEAD"].includes(method) || headers.origin === `https://${headers.host}`;
}
export function publicProxyPath(pathname: string): boolean {
  return /^\/(?:info|proposals(?:\/[0-9]+)?|delegates(?:\/0x[0-9a-fA-F]{40})?)\/?$/.test(pathname)
    || pathname.startsWith("/_next/static/") || pathname === "/_next/image"
    || /^\/[a-zA-Z0-9_./-]+\.(?:svg|png|jpg|webp|ico|woff2?|ttf)$/.test(pathname);
}
export function publicSnapshot(value: unknown): unknown {
  // Evidence is intentionally public. Operator attribution and credentials are not.
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) => {
    if (/^(requestedBy|email|privateKey|privateKeys|secret|secrets|apiKey|accessToken|authorization|rpcUrl|rpcHttp|rpcWs)$/i.test(key)) return undefined;
    if (typeof entry !== "string") return entry;
    return entry.replace(/sk-or-v1-[a-zA-Z0-9_-]+|alch_[a-zA-Z0-9_-]+|Bearer\s+\S+/g, "[redacted]")
      .replace(/https?:\/\/[^\s"<>]*(?:alchemy\.com|alchemyapi\.io)\/[^\s"<>]*/gi, "[private RPC]");
  }));
}
