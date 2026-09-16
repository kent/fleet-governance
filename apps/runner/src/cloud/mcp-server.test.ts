import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), create: vi.fn(), run: vi.fn() }));
vi.mock("./operator-tokens.js", () => ({ authenticateOperatorToken: mocks.authenticate }));
vi.mock("./experiment-drafts.js", async original => ({ ...await original<typeof import("./experiment-drafts.js")>(), createExperimentDraft: mocks.create, runExperimentDraft: mocks.run }));
import { handleMcpRequest } from "./mcp-server.js";
let server: Server; let url: URL;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.authenticate.mockImplementation(async (header: string) => header === "Bearer verified-personal-token" ? "operator3@example.com" : null);
  server = createServer(handleMcpRequest); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  url = new URL(`http://127.0.0.1:${address.port}/mcp`);
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
describe("real MCP HTTP transport", () => {
  it("rejects anonymous, forged IAP identity and hostile browser origin before tools", async () => {
    for (const headers of [{}, { "x-goog-authenticated-user-email": "accounts.google.com:operator1@example.com" }]) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      expect(response.status).toBe(401);
    }
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer verified-personal-token", origin: "https://attacker.example" }, body: "{}" });
    expect(response.status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("supports SDK discovery, reads, drafts and launch with server-derived identity", async () => {
    const client = new Client({ name: "test-research-client", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer verified-personal-token" } } }) as Transport);
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(10);
    const defaults = await client.callTool({ name: "experiment_defaults", arguments: {} });
    expect(JSON.parse((defaults.content as { text: string }[])[0]!.text)).toMatchObject({ maxAgents: 5 });
    const runId = "run-00000000-0000-4000-8000-000000000001";
    mocks.create.mockResolvedValue({ runId });
    await client.callTool({ name: "create_experiment", arguments: { runId, settings: {} } });
    expect(mocks.create).toHaveBeenCalledWith(runId, expect.objectContaining({ agentCount: 5 }), "operator3@example.com");
    mocks.run.mockResolvedValue({ runId, phase: "queued" });
    await client.callTool({ name: "run_experiment", arguments: { runId } });
    expect(mocks.run).toHaveBeenCalledWith(runId, "operator3@example.com");
    await client.close();
  });
});
