import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/index.js";

test("lowercases and hyphenates", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("trims leading and trailing hyphens", () => {
  assert.equal(slugify("  Wow!!  "), "wow");
});

test("collapses runs of separators into one hyphen", () => {
  assert.equal(slugify("a   b---c"), "a-b-c");
});

test("keeps digits", () => {
  assert.equal(slugify("Chapter 9: The End"), "chapter-9-the-end");
});

test("returns an empty string when nothing is alphanumeric", () => {
  assert.equal(slugify("!!!"), "");
});
