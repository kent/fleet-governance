import { describe, expect, it } from "vitest";
import { GET } from "./route.js";

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/runs/[id]/state", () => {
  it.each(["..", "../../etc/passwd", "a/b", "a%2fb", ""])("rejects the invalid run id %j with 400, echoing nothing", async (badId) => {
    const res = await GET(new Request("http://localhost/api/runs/x/state"), ctx(badId));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid run id");
    if (badId !== "") expect(body.error).not.toContain(badId);
  });

  it("passes id validation for a normal id and returns the assembled (near-empty) view", async () => {
    const res = await GET(new Request("http://localhost/api/runs/x/state"), ctx("no-such-run-xyz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; stage: string | null };
    expect(body.runId).toBe("no-such-run-xyz");
    expect(body.stage).toBeNull();
  }, 15000);
});
