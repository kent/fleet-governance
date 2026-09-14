import { describe, expect, it } from "vitest";
import { GET } from "./route.js";

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/runs/[id]/report", () => {
  it.each(["..", "../../etc/passwd", "a/b", "a%2fb", ""])("rejects the invalid run id %j with 400, echoing nothing", async (badId) => {
    const res = await GET(new Request("http://localhost/api/runs/x/report"), ctx(badId));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid run id");
    if (badId !== "") expect(body.error).not.toContain(badId);
  });

  it("passes id validation for a normal id and reaches the real not-found check", async () => {
    const res = await GET(new Request("http://localhost/api/runs/x/report"), ctx("no-such-run-xyz"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("invalid run id");
  });
});
