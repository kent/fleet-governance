import { test } from "node:test";
import assert from "node:assert/strict";
import { groupBy } from "../src/index.js";

test("groups numbers by a derived key", () => {
  const result = groupBy([1, 2, 3, 4, 5], (n) => (n % 2 === 0 ? "even" : "odd"));
  assert.deepEqual(result, { even: [2, 4], odd: [1, 3, 5] });
});

test("groups objects by a property", () => {
  const items = [{ type: "a", id: 1 }, { type: "b", id: 2 }, { type: "a", id: 3 }];
  const result = groupBy(items, (item) => item.type);
  assert.deepEqual(result, {
    a: [{ type: "a", id: 1 }, { type: "a", id: 3 }],
    b: [{ type: "b", id: 2 }],
  });
});

test("coerces keys with String()", () => {
  const result = groupBy([1, 2, 3], (n) => n);
  assert.deepEqual(Object.keys(result).sort(), ["1", "2", "3"]);
});

test("returns an empty object for an empty array", () => {
  assert.deepEqual(groupBy([], (item) => item), {});
});

test("preserves insertion order within a group", () => {
  const result = groupBy(["b1", "a1", "b2", "a2"], (s) => s[0]);
  assert.deepEqual(result, { b: ["b1", "b2"], a: ["a1", "a2"] });
});
