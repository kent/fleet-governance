import { describe, expect, it } from "vitest";
import { AllocationRequest, nativeStopAt, type NativeVm } from "./compute-admin.js";

const vm: NativeVm = { id: "1", status: "RUNNING", lastStartTimestamp: "2026-09-15T16:00:00Z",
  scheduling: { automaticRestart: false, instanceTerminationAction: "STOP" },
  resourceStatus: { scheduling: { terminationTimestamp: "2026-09-15T20:00:00Z" } } };
const now = Date.parse("2026-09-15T16:01:00Z") / 1000;
describe("human compute allocation", () => {
  it("inherits the actual native deadline, never renews from the current time", () => {
    expect(nativeStopAt(vm, now)).toBe(Date.parse("2026-09-15T20:00:00Z") / 1000);
  });
  it("rejects missing, expired, oversized or automatically restarting allocations", () => {
    expect(() => nativeStopAt({ ...vm, resourceStatus: {} }, now)).toThrow();
    expect(() => nativeStopAt(vm, now + 14400)).toThrow();
    expect(() => nativeStopAt(vm, now - 3600)).toThrow();
    expect(() => nativeStopAt({ ...vm, scheduling: { ...vm.scheduling, automaticRestart: true } }, now)).toThrow();
    expect(() => nativeStopAt({ ...vm, status: "TERMINATED" }, now)).toThrow();
  });
  it("cannot accept a caller-selected machine, project or budget extension", () => {
    expect(AllocationRequest.safeParse({ runId: "run-00000000-0000-4000-8000-000000000001",
      governor: "0x" + "1".repeat(40), requiredProposalIds: ["1"], stopAt: now + 99999 }).success).toBe(false);
  });
});
