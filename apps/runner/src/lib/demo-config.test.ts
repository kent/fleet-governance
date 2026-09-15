import { expect, it } from "vitest";
import { keccak256, toHex } from "viem";
import { createDemoConfig, parseDemoRequest } from "./demo-config.js";

const request = { agentCount: 5, goal: "Fix the functions and propose publication.", constitution: "custom", customConstitution: "Require independent review and explain unresolved uncertainty." };
it("preserves the goal and custom constitution, fixes FleetGov and keeps five actual model members", () => {
  const { config, constitutionHash } = createDemoConfig(request, { repoRoot: process.cwd(), name: "pilot", rpcHttp: "https://example.com", rpcWs: "wss://example.com", agoraUrl: "https://example.com" });
  expect(config.task.charter.goal).toBe(request.goal);
  expect(config.task.charterSource).toBe("experiment");
  expect(config.task.constitution?.text).toBe(request.customConstitution);
  expect(constitutionHash).toBe(keccak256(toHex(request.customConstitution)));
  expect(config.task.charter.notes).toContain(constitutionHash);
  expect(config.fleet.members).toHaveLength(5);
  expect(config.fleet.members.every(member => member.provider === "openrouter")).toBe(true);
  expect(config.fleet.tokenName).toBe("FleetGov");
  expect(config.inference?.budget).toMatchObject({ maxCostUsd: 1, providerCreditPoolUsd: 50 });
});
it.each([{ agentCount: 0 }, { agentCount: 5.5 }, { agentCount: 2001 }, { goal: "" }, { constitution: "unknown" }, { customConstitution: "" }, { rpcHttp: "http://malicious" }, { maxCostUsd: 100 }])("refuses invalid or privileged browser settings: %j", override => {
  expect(() => parseDemoRequest({ ...request, ...override })).toThrow();
});
