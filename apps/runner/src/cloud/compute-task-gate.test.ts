import { describe, expect, it } from "vitest";
import { taskAuthority } from "./compute-task-gate.js";
import type { ComputeAllocation, ComputeState } from "./compute-policy.js";
const allocation = { allocationId: "allocation", runId: "run", stopAt: 200, maxObservationAgeSeconds: 30 } as ComputeAllocation;
const state: ComputeState = { allocationId: "allocation", phase: "authorised", observedAt: 100 };
describe("compute task dispatch authority", () => {
  it("waits on pending, missing and stale authority, allows fresh settled authority", () => {
    expect(taskAuthority({ blocked: false, allocation, state }, "run", 110)).toBe("allow");
    expect(taskAuthority({ blocked: false, allocation, state }, "run", 140)).toBe("wait");
    expect(taskAuthority({ blocked: false, allocation, state: null }, "run", 110)).toBe("wait");
    expect(taskAuthority({ blocked: false, allocation, state: { ...state, phase: "voting" } }, "run", 110)).toBe("wait");
  });
  it("halts failed, expired, mismatched or previously blocked run generations", () => {
    expect(taskAuthority({ blocked: false, allocation, state: { ...state, phase: "halted" } }, "run", 110)).toBe("halt");
    expect(taskAuthority({ blocked: false, allocation, state }, "run", 200)).toBe("halt");
    expect(taskAuthority({ blocked: false, allocation, state }, "old-run", 110)).toBe("halt");
    expect(taskAuthority({ blocked: true, allocation: null, state: null }, "run", 110)).toBe("halt");
  });
});
