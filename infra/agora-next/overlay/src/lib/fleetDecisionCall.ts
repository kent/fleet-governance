import { decodeFunctionData, parseAbi, toFunctionSelector } from "viem";

// The FleetHook allows one TaskLedger.recordDecision call per proposal. Decode its public
// calldata with the pinned contract signature, without a third-party explorer API key.
export const fleetDecisionAbi = parseAbi([
  "function recordDecision(uint256 taskId, uint8 kind, uint32 expectedVersion, bytes32 payloadHash, string newCharterText, string summary)",
]);

export function decodeFleetDecisionCall(data: `0x${string}`) {
  if (data.slice(0, 10).toLowerCase() !== toFunctionSelector(fleetDecisionAbi[0])) return null;
  const decoded = decodeFunctionData({ abi: fleetDecisionAbi, data });
  return {
    function: decoded.functionName,
    parameters: Object.fromEntries(fleetDecisionAbi[0].inputs.map((input, index) => [input.name, {
      type: input.type, value: String(decoded.args[index]),
    }])),
  };
}
