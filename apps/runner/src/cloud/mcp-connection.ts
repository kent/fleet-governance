import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { authenticateOperatorToken } from "./operator-tokens.js";
import type { OperatorEmail } from "./operators.js";

/** A signed-in human can check their own credential through the real HTTPS MCP
 * transport. Endpoint and read-only calls are fixed; this is not a generic proxy. */
export async function checkMcpConnection(requestedBy: OperatorEmail, input: unknown) {
  const { token } = z.object({ token: z.string().regex(/^fleet_mcp_[A-Za-z0-9_-]{43}$/) }).strict().parse(input);
  if (await authenticateOperatorToken(`Bearer ${token}`) !== requestedBy) throw new Error("Use an active credential belonging to your signed-in account.");
  const client = new Client({ name: "fleet-operator-connection-check", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://fleet-governance-mcp-449245570324.us-central1.run.app/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  try {
    await client.connect(transport as Transport);
    const tools = await client.listTools();
    const defaults = await client.callTool({ name: "experiment_defaults", arguments: {} });
    if (defaults.isError || tools.tools.length !== 10) throw new Error("MCP tool check failed.");
    const limits = z.object({ maxAgents: z.literal(5), maxRunBudgetUsd: z.literal(1), modelPoolUsd: z.literal(50) }).parse(JSON.parse((defaults.content as { text: string }[])[0]!.text));
    return { connected: true, toolCount: tools.tools.length, ...limits, checkedAt: new Date().toISOString(), modelCalls: 0, launchedExperiments: 0 };
  } finally { await client.close(); }
}
