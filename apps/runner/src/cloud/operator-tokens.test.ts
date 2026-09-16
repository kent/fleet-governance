import { beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
const mocks = vi.hoisted(() => ({ read: vi.fn(), put: vi.fn(), remove: vi.fn(), request: vi.fn() }));
vi.mock("./protected-records.js", () => ({ protectedRecord: mocks.read, putProtected: mocks.put, deleteProtected: mocks.remove }));
vi.mock("./google.js", () => ({ googleRequest: mocks.request }));
import { AUTH_BUCKET, issueOperatorToken, authenticateOperatorToken, revokeOperatorToken } from "./operator-tokens.js";
const record = { schema: "fleet.mcp-token.v1", requestedBy: "operator3@example.com", label: "Research", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
beforeEach(() => { vi.resetAllMocks(); mocks.request.mockResolvedValue({ json: async () => ({ items: [] }) }); });
describe("personal MCP credentials", () => {
  it("stores only a high-entropy token hash in a separate bucket", async () => {
    const value = await issueOperatorToken("operator3@example.com", { label: "Research", hours: 12 });
    expect(value.token).toMatch(/^fleet_mcp_[\w-]{43}$/);
    expect(mocks.put).toHaveBeenCalledWith(`tokens/${createHash("sha256").update(value.token).digest("hex")}.json`, expect.objectContaining({ requestedBy: "operator3@example.com" }), "0", AUTH_BUCKET);
    expect(JSON.stringify(mocks.put.mock.calls)).not.toContain(value.token);
  });
  it("authenticates the stored owner, never a client-provided email", async () => {
    mocks.read.mockResolvedValue({ value: record, generation: "1" });
    expect(await authenticateOperatorToken(`Bearer fleet_mcp_${"a".repeat(43)}`)).toBe("operator3@example.com");
    for (const value of [undefined, "Bearer operator1@example.com", "Basic example", `Bearer fleet_mcp_${"a".repeat(42)}`]) expect(await authenticateOperatorToken(value)).toBeNull();
  });
  it("checks expiry and revocation on every request", async () => {
    mocks.read.mockResolvedValueOnce({ value: { ...record, expiresAt: new Date(Date.now() - 1).toISOString() } }).mockResolvedValueOnce(null);
    for (let i = 0; i < 2; i++) expect(await authenticateOperatorToken(`Bearer fleet_mcp_${"a".repeat(43)}`)).toBeNull();
  });
  it("denies issuance to an unlisted identity and revocation of another person's token", async () => {
    await expect(issueOperatorToken("stranger@example.com" as never, { label: "x" })).rejects.toThrow();
    mocks.read.mockResolvedValue({ value: record, generation: "1" });
    await expect(revokeOperatorToken("operator1@example.com", "a".repeat(64))).rejects.toThrow("another operator");
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
