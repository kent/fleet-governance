import roster from "./fleet-agent-roster.json";

/** Public pilot identities, never a substitute for the underlying wallet address. */
export function fleetAgentName(address?: string): string | undefined {
  if (process.env.NEXT_PUBLIC_AGORA_INSTANCE_NAME !== "fleet" || !address) return;
  return roster.find(agent => agent.address.toLowerCase() === address.toLowerCase())?.name;
}
