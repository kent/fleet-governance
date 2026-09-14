import { afterEach, describe, expect, it } from "vitest";
import { GET } from "./route.js";

function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

const openResponses: Response[] = [];

afterEach(() => {
  // Never leave a stream's reader open across tests; cancel whatever this test opened.
  for (const res of openResponses.splice(0)) {
    void res.body?.cancel();
  }
});

describe("GET /api/runs/[id]/events", () => {
  it.each(["..", "../../etc/passwd", "a/b", "a%2fb", ""])("rejects the invalid run id %j with 400, echoing nothing", async (badId) => {
    const controller = new AbortController();
    const res = await GET(new Request("http://localhost/api/runs/x/events", { signal: controller.signal }), ctx(badId));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid run id");
    if (badId !== "") expect(body.error).not.toContain(badId);
    controller.abort();
  });

  it("passes id validation for a normal id and opens a real SSE stream", async () => {
    const controller = new AbortController();
    const res = await GET(new Request("http://localhost/api/runs/x/events", { signal: controller.signal }), ctx("no-such-run-xyz"));
    openResponses.push(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    controller.abort();
  });
});
