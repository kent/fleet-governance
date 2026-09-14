import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "../src/index.js";

test("parses hours and minutes combined", () => {
  assert.equal(parseDuration("1h30m"), 5400000);
});

test("parses milliseconds without confusing them with minutes", () => {
  assert.equal(parseDuration("500ms"), 500);
});

test("parses seconds", () => {
  assert.equal(parseDuration("45s"), 45000);
});

test("parses three units together", () => {
  assert.equal(parseDuration("2h15m30s"), 8130000);
});

test("throws TypeError on an empty string", () => {
  assert.throws(() => parseDuration(""), TypeError);
});

test("throws TypeError on unrecognized input", () => {
  assert.throws(() => parseDuration("nonsense"), TypeError);
});
