import { expect, it } from "vitest";
import { encodeFunctionData } from "viem";
import { decodeFleetDecisionCall, fleetDecisionAbi } from "@/lib/fleetDecisionCall";

it("decodes the actual Fleet ledger call without rounding large identifiers", () => {
  const taskId = 2n ** 200n;
  const data = encodeFunctionData({ abi: fleetDecisionAbi, functionName: "recordDecision", args: [taskId, 1, 2, `0x${"ab".repeat(32)}`, "", "Require test evidence"] });
  expect(decodeFleetDecisionCall(data)).toMatchObject({ function: "recordDecision", parameters: {
    taskId: { type: "uint256", value: taskId.toString() }, kind: { type: "uint8", value: "1" },
    expectedVersion: { value: "2" }, summary: { value: "Require test evidence" },
  } });
});

it("leaves unknown calls undecoded and refuses malformed known calldata", () => {
  expect(decodeFleetDecisionCall("0x12345678")).toBeNull();
  const data = encodeFunctionData({ abi: fleetDecisionAbi, functionName: "recordDecision", args: [1n, 0, 1, `0x${"00".repeat(32)}`, "", "test"] });
  expect(() => decodeFleetDecisionCall(data.slice(0, 10) as `0x${string}`)).toThrow();
});
