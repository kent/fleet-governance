import { describe, expect, it } from "vitest";
import { authorisedRequest, publicProxyPath, publicSnapshot, siteAccess } from "./site-access.js";

const forged = { "x-goog-authenticated-user-email": "accounts.google.com:operator2@example.com", host: "demo.run.app", origin: "https://demo.run.app" };
describe("public viewing boundary", () => {
  it("allows anonymous reads and rejects every mutation even with spoofed operator headers", () => {
    for (const method of ["GET", "HEAD"]) expect(authorisedRequest("public", method, {})).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "CONNECT", "OPTIONS"]) {
      expect(authorisedRequest("public", method, {})).toBe(false);
      expect(authorisedRequest("public", method, forged)).toBe(false);
    }
  });
  it("keeps operator routes authenticated and rejects cross-origin writes", () => {
    expect(authorisedRequest("operator", "GET", {})).toBe(false);
    expect(authorisedRequest("operator", "POST", forged)).toBe(true);
    expect(authorisedRequest("operator", "POST", { ...forged, origin: "https://elsewhere.example" })).toBe(false);
    expect(authorisedRequest("operator", "POST", { ...forged, origin: undefined })).toBe(false);
    expect(() => siteAccess(undefined)).toThrow();
    expect(() => siteAccess("pubic")).toThrow();
  });
  it("limits the anonymous Agora proxy to pages and assets", () => {
    for (const path of ["/info", "/proposals/123", "/delegates", "/_next/static/chunk.js"]) expect(publicProxyPath(path)).toBe(true);
    for (const path of ["/api/worker/start", "/api/admin", "/proposals/create-proposal", "/.env", "/api/experiments"]) expect(publicProxyPath(path)).toBe(false);
  });
  it("preserves public vote evidence but removes attribution and credentials recursively", () => {
    expect(publicSnapshot({ requestedBy: "operator@example.com", votes: [{ reason: "Outside the charter", txHash: "0x123", privateKey: "private", nested: { rpcUrl: "secret" } }], error: "sk-or-v1-example alch_example" })).toEqual({ votes: [{ reason: "Outside the charter", txHash: "0x123", nested: {} }], error: "[redacted] [redacted]" });
  });
});
