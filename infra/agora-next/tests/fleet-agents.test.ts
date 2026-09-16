import { afterEach, expect, it, vi } from "vitest";
import { fleetAgentName } from "@/lib/fleetAgents";

afterEach(() => vi.unstubAllEnvs());
it("names the known pilot wallets without replacing unknown wallets or other tenants", () => {
  vi.stubEnv("NEXT_PUBLIC_AGORA_INSTANCE_NAME", "fleet");
  expect(fleetAgentName("0x5b71A4C4E3E83E31d306d11079E312893b437Ac5")).toBe("Agent1");
  expect(fleetAgentName("0xf60340ed67fa1b1195dbeffe825455f7ea365150")).toBe("Agent5");
  expect(fleetAgentName(`0x${"00".repeat(20)}`)).toBeUndefined();
  vi.stubEnv("NEXT_PUBLIC_AGORA_INSTANCE_NAME", "optimism");
  expect(fleetAgentName("0x5b71A4C4E3E83E31d306d11079E312893b437Ac5")).toBeUndefined();
});
