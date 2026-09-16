import { type IncomingMessage, type ServerResponse } from "node:http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateOperatorToken } from "./operator-tokens.js";
import { experimentMcpServer } from "./mcp-tools.js";

export const MCP_URL = "https://fleet-governance-mcp-449245570324.us-central1.run.app/mcp";
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
export async function handleMcpRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = new URL(request.url ?? "/", MCP_URL);
    if (url.pathname === "/healthz" && request.method === "GET") { json(response, 200, { ok: true }); return; }
    if (url.pathname !== "/mcp") { json(response, 404, { error: "Use /mcp with a personal operator credential." }); return; }
    // A native MCP client has no Origin. Browser origins must be this service.
    if (request.headers.origin && request.headers.origin !== new URL(MCP_URL).origin) { json(response, 403, { error: "Origin is not allowed." }); return; }
    const operator = await authenticateOperatorToken(request.headers.authorization);
    if (!operator) { response.setHeader("WWW-Authenticate", 'Bearer realm="fleet-governance"'); json(response, 401, { error: "Create a personal MCP credential at the operator website /mcp-access. Only authorised operators can run experiments." }); return; }
    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) { json(response, 405, { error: "Method not allowed." }); return; }
    let parsed: unknown;
    if (request.method === "POST") {
      if (!request.headers["content-type"]?.includes("application/json")) { json(response, 415, { error: "Use application/json." }); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 200_000) { json(response, 413, { error: "Request is too large." }); return; } chunks.push(chunk); }
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    const server = experimentMcpServer(operator);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on("close", () => { void transport.close(); void server.close(); });
    // SDK 1.x optional callback declarations predate exactOptionalPropertyTypes.
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, parsed);
  } catch {
    if (!response.headersSent) json(response, 400, { error: "MCP request failed. Inspect the run or batch before retrying a mutation." });
    else response.end();
  }
}
