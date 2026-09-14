import { describe, expect, it, vi } from "vitest";
import type { CharterV1 } from "@fleet/schemas";
import { TaskState, payloadHashForAction } from "@fleet/sdk";
import { LedgerWatcher, describeAction } from "@fleet/gateway";
import type { GatewayLogRecord } from "@fleet/gateway";
import { packageFetch, packageRequestTool } from "./package-broker.js";

function setup() {
  const state = { paused: false, version: 1, approved: new Map<string, number>(), escalated: false };
  const charter: CharterV1 = { schema: "fleet.charter.v1", goal: "Install a package", allowedActionClasses: ["network_fetch"],
    forbiddenActions: [], externalAllowlist: ["registry.example"], budget: { toolCalls: 20, inferenceTokens: 1000 }, stopConditions: [] };
  const watcher = new LedgerWatcher({ getTask: async () => ({ id: 1n, operator: `0x${"11".repeat(20)}`, createdAt: 1n,
    expiresAt: 1000n, state: TaskState.Open, charterVersion: state.version, charterHash: `0x${"22".repeat(32)}`,
    charterText: JSON.stringify(charter), charter, decisionCount: 0, openEscalations: 0 }),
    isPaused: async () => state.paused, blockNumber: async () => BigInt(state.version), timestamp: async () => 2n,
    exceptionVersion: async (_, hash) => state.approved.get(hash) ?? 0,
    escalationVersion: async () => state.escalated ? 1 : 0 }, 1n);
  const usage = { toolCalls: 0 }; const logs: GatewayLogRecord[] = [];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("package"));
  return { state, usage, logs, fetchImpl,
    download: packageFetch({ watcher, usage, agentId: 7, log: r => logs.push(r), fetchImpl }) };
}
const signal = (): AbortSignal => new AbortController().signal;

describe("package download broker", () => {
  it.each(["http://registry.example/pkg", "file:///etc/passwd", "https://u:p@registry.example/pkg",
    "https://registry.example:444/pkg", "https://registry.example/pkg#fragment", "https://[::1]/pkg"])("refuses %s before dispatch", async url => {
    const s = setup();
    await expect(s.download(url, signal())).rejects.toThrow();
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("checks the exact path and query, then invalidates an old exception after amendment", async () => {
    const s = setup(); const url = "https://outside.example/pkg.tgz?v=1";
    const tool = packageRequestTool(url);
    const hash = payloadHashForAction(describeAction(tool));
    await expect(s.download(url, signal())).rejects.toMatchObject({ tool, blocked: { reason: "target_not_allowlisted", payloadHash: hash } });
    expect(s.fetchImpl).not.toHaveBeenCalled();
    s.state.approved.set(hash, 1);
    expect(Buffer.from((await s.download(url, signal())).body).toString()).toBe("package");
    await expect(s.download("https://outside.example/pkg.tgz?v=2", signal())).rejects.toMatchObject({ blocked: { reason: "target_not_allowlisted" } });
    s.state.version = 2;
    await expect(s.download(url, signal())).rejects.toMatchObject({ blocked: { reason: "target_not_allowlisted" } });
    expect(s.fetchImpl).toHaveBeenCalledTimes(1);
    expect(s.logs.map(r => r.verdict)).toEqual(["BLOCK", "ALLOW", "BLOCK", "BLOCK"]);
    expect(s.usage.toolCalls).toBe(4);
  });

  it("does not dispatch after a pause, escalation, exhausted budget or canceled request", async () => {
    const s = setup(); const url = "https://registry.example/pkg";
    s.state.paused = true;
    await expect(s.download(url, signal())).rejects.toMatchObject({ blocked: { reason: "paused" } });
    s.state.paused = false; s.state.escalated = true;
    await expect(s.download(url, signal())).rejects.toMatchObject({ blocked: { reason: "escalated" } });
    s.state.escalated = false; s.usage.toolCalls = 20;
    await expect(s.download(url, signal())).rejects.toMatchObject({ blocked: { reason: "budget_exhausted" } });
    await expect(s.download(url, AbortSignal.abort())).rejects.toThrow();
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });

  it("uses credential-free GETs and refuses redirects without following them", async () => {
    const s = setup();
    s.fetchImpl.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://outside.example/secret" } }));
    await expect(s.download("https://registry.example/pkg", signal())).rejects.toThrow("package_redirect_refused");
    expect(s.fetchImpl).toHaveBeenCalledOnce();
    expect(s.fetchImpl).toHaveBeenCalledWith("https://registry.example/pkg", {
      method: "GET", redirect: "manual", credentials: "omit", signal: expect.any(AbortSignal),
      headers: { accept: "application/vnd.npm.install-v1+json, application/json, */*" },
    });
  });

  it("caps both declared and streamed response bytes", async () => {
    const s = setup();
    s.fetchImpl.mockResolvedValueOnce(new Response("small", { headers: { "content-length": String(17 * 1024 * 1024) } }));
    await expect(s.download("https://registry.example/pkg", signal())).rejects.toThrow("package_download_too_large");
    s.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(17 * 1024 * 1024)); c.close(); } })));
    await expect(s.download("https://registry.example/pkg", signal())).rejects.toThrow("package_download_too_large");
  });

  it("cancels a stalled body read rather than retaining an unfinished download", async () => {
    const s = setup(); const cancel = vi.fn(); const abort = new AbortController();
    let read!: () => void; const reading = new Promise<void>(resolve => { read = resolve; });
    s.fetchImpl.mockResolvedValue(new Response(new ReadableStream({ pull() { read(); }, cancel }, { highWaterMark: 0 })));
    const pending = s.download("https://registry.example/pkg", abort.signal);
    await reading; abort.abort();
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
