import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ authenticate: vi.fn(), connect: vi.fn(), list: vi.fn(), call: vi.fn(), close: vi.fn() }));
vi.mock("./operator-tokens.js", () => ({ authenticateOperatorToken: m.authenticate }));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class { connect = m.connect; listTools = m.list; callTool = m.call; close = m.close; } }));
import { checkMcpConnection } from "./mcp-connection.js";
const token = `fleet_mcp_${"a".repeat(43)}`;
beforeEach(() => vi.resetAllMocks());
it("rejects another person's, expired and invalid credentials before network access", async () => {
  for (const email of [null, "operator3@example.com"]) {
    m.authenticate.mockResolvedValue(email);
    await expect(checkMcpConnection("operator1@example.com", { token })).rejects.toThrow("signed-in account");
  }
  await expect(checkMcpConnection("operator1@example.com", { token: "other-provider-secret" })).rejects.toThrow();
  expect(m.connect).not.toHaveBeenCalled();
});
it("checks only the fixed live tools and limits, without creating experiments", async () => {
  m.authenticate.mockResolvedValue("operator1@example.com");
  m.list.mockResolvedValue({ tools: Array(10).fill({}) });
  m.call.mockResolvedValue({ content: [{ text: JSON.stringify({ maxAgents: 5, maxRunBudgetUsd: 1, modelPoolUsd: 50 }) }] });
  expect(await checkMcpConnection("operator1@example.com", { token })).toMatchObject({ connected: true, toolCount: 10, launchedExperiments: 0 });
  expect(m.call).toHaveBeenCalledExactlyOnceWith({ name: "experiment_defaults", arguments: {} });
  expect(m.close).toHaveBeenCalled();
});
