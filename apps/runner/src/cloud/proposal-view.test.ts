import { describe, expect, it, vi } from "vitest";
import { failedProposalDocument, readProposalDocument } from "./proposal-view.js";

describe("proposal document availability", () => {
  it("detects Next streamed errors even when the HTTP status is 200", () => {
    expect(failedProposalDocument(200, '<script>self.__next_f.push([1,"8:E{\\"digest\\":\\"936997603\\"}\\n"])</script>')).toBe(true);
    expect(failedProposalDocument(200, '8:E{"digest":"936997603"}')).toBe(true);
    expect(failedProposalDocument(500, "error")).toBe(true);
    expect(failedProposalDocument(200, '<h1>Vote on the artifact digest</h1>')).toBe(false);
  });
  it("returns the intact Agora document or a fallback signal without forwarding user credentials", async () => {
    const fetcher = vi.fn(async () => new Response('<h1>Agora proposal</h1>', { headers: { "content-type": "text/html" } }));
    expect(await readProposalDocument("10.42.0.2", "/proposals/123", fetcher)).toContain("Agora proposal");
    expect(fetcher).toHaveBeenCalledWith("http://10.42.0.2:3000/proposals/123", expect.objectContaining({ headers: { accept: "text/html" }, redirect: "error" }));
    fetcher.mockRejectedValueOnce(new Error("worker stopped"));
    expect(await readProposalDocument("10.42.0.2", "/proposals/123", fetcher)).toBeNull();
    await expect(readProposalDocument("example.com", "/proposals/123", fetcher)).rejects.toThrow("Invalid proposal destination");
  });
});
