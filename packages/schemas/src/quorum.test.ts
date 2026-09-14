import { describe, expect, it } from "vitest";
import { effectiveYesCount } from "./quorum.js";

describe("effectiveYesCount", () => {
  it.each([
    [5, 6000, 3],
    [7, 6000, 5],
    [10, 6000, 6],
    [3, 6000, 2],
  ])("effectiveYesCount(%i, %i) === %i", (n, quorumNumerator, expected) => {
    expect(effectiveYesCount(n, quorumNumerator)).toBe(expected);
  });

  it("returns the exact count when it already clears the threshold", () => {
    expect(effectiveYesCount(2, 5000)).toBe(1);
  });

  it("returns 0 when there are no votes", () => {
    expect(effectiveYesCount(0, 6000)).toBe(0);
  });
});
