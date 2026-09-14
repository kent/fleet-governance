import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const archive = vi.hoisted(() => ({ url: "", sources: [] as string[] }));
vi.mock("@/lib/tenant/tenant", () => ({ default: { current: () => ({ namespace: "fleet" }) } }));
vi.mock("@/lib/constants", () => ({
  getArchiveSlugForProposalVotes: () => archive.url,
  getArchiveSlugAllProposals: () => [archive.url], getArchiveUrlsForProposal: () => archive.sources,
  getArchiveSlugForProposalNonVoters: () => archive.url,
}));
import { GET } from "../src/app/api/archive/votes/[proposalId]/route";
import { fetchProposalsFromArchive, fetchProposalFromArchive } from "../src/lib/archiveUtils";

const ballot = { voter: "0x1111111111111111111111111111111111111111", support: "0",
  weight: "1000000000000000000", reason: "AGAINST. The charter prohibits this access." };
const server = createServer((req, res) => {
  if (req.url?.startsWith("/missing")) { res.writeHead(404); res.end(); return; }
  if (req.url?.startsWith("/unavailable")) { res.writeHead(503, "Not Found"); res.end(); return; }
  res.writeHead(200, { "Content-Type": "application/octet-stream" });
  if (req.url?.startsWith("/proposal")) { res.end(gzipSync(JSON.stringify({ id: "123", block_number: "42" }))); return; }
  res.end(gzipSync(req.url?.startsWith("/empty") ? "" : req.url?.startsWith("/corrupt") ? "not json"
    : req.url?.startsWith("/partial") ? JSON.stringify(ballot) + "\nnot json" : JSON.stringify(ballot) + "\n"));
});

describe("proposal archive availability", () => {
  it("reads a valid fleet proposal list", async () => {
    archive.url = `${baseUrl}/proposal`;
    const result = await fetchProposalsFromArchive("fleet", "all");
    expect(result.data.map(proposal => proposal.id)).toEqual(["123"]);
  });
  it.each(["missing", "partial"])("rejects a %s fleet list instead of omitting proposals", async route => {
    archive.url = `${baseUrl}/${route}`;
    await expect(fetchProposalsFromArchive("fleet", "all")).rejects.toThrow();
  });
  it("uses a valid detail result when another configured source is unavailable", async () => {
    archive.sources = [`${baseUrl}/unavailable`, `${baseUrl}/proposal`];
    expect(await fetchProposalFromArchive("fleet", "123")).toMatchObject({ id: "123" });
  });
  it("returns not found only when every detail source reports a missing object", async () => {
    archive.sources = [`${baseUrl}/missing`];
    expect(await fetchProposalFromArchive("fleet", "123")).toBeNull();
  });
  it("preserves a detail read error when no source returned the proposal", async () => {
    archive.sources = [`${baseUrl}/missing`, `${baseUrl}/unavailable`];
    await expect(fetchProposalFromArchive("fleet", "123")).rejects.toThrow();
  });
});
let baseUrl: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

async function readVotes(route: string) {
  archive.url = `${baseUrl}/${route}`;
  return GET(new NextRequest("http://fleet.test/api/archive/votes/123"), { params: Promise.resolve({ proposalId: "123" }) });
}

describe("the built Agora vote route and archive reader", () => {
  it("retains the actual ballot and its public reason", async () => {
    const response = await readVotes("ballots");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [ballot] });
  });
  it("allows an explicitly empty archive without inventing votes", async () => {
    const response = await readVotes("empty");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [] });
  });
  it.each(["missing", "unavailable", "corrupt", "partial"])("does not present a %s archive as a complete vote list", async route => {
    const response = await readVotes(route);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Vote records are temporarily unavailable. Please try again.");
  });
});
