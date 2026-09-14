import { describe, expect, it } from "vitest";
import { POST } from "./route.js";

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/runs/x/guardian", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/runs/[id]/guardian", () => {
  it.each(["..", "../../etc/passwd", "a/b", "a%2fb", ""])(
    "rejects the invalid run id %j with 400, echoing nothing, without ever parsing the body",
    async (badId) => {
      const res = await POST(postRequest({ action: "pause" }), ctx(badId));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid run id");
      if (badId !== "") expect(body.error).not.toContain(badId);
    },
  );

  it("passes id validation for a normal id and reaches the real guardian-key check", async () => {
    const res = await POST(postRequest({ action: "pause" }), ctx("no-such-run-xyz"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Proves it got past the id gate: a different, unrelated error.
    expect(body.error).not.toBe("invalid run id");
    expect(body.error).toContain("FLEET_GUARDIAN_KEY");
  });
});
