import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.js";

describe("canonicalize", () => {
  it("sorts object keys lexicographically", () => {
    const value = { b: 1, a: 2 };
    expect(canonicalize(value)).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys, at every level", () => {
    const value = { b: 1, a: { d: 2, c: 3 } };
    expect(canonicalize(value)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order, including arrays of objects", () => {
    const value = { list: [{ z: 1, a: 2 }, { b: 3 }] };
    expect(canonicalize(value)).toBe('{"list":[{"a":2,"z":1},{"b":3}]}');
  });

  it("preserves the order of a top-level array", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("produces output with no added whitespace", () => {
    const value = { a: 1, b: [1, 2, 3], c: { d: "e" } };
    expect(canonicalize(value)).not.toMatch(/\s/);
  });

  it("serializes strings, booleans, and null", () => {
    expect(canonicalize({ s: "hi", t: true, f: false, n: null })).toBe(
      '{"f":false,"n":null,"s":"hi","t":true}',
    );
  });

  it("throws when a nested object value is undefined", () => {
    expect(() => canonicalize({ a: undefined })).toThrow();
  });

  it("throws when the top-level value is undefined", () => {
    expect(() => canonicalize(undefined)).toThrow();
  });

  it("throws when an array element is undefined", () => {
    expect(() => canonicalize([1, undefined, 3])).toThrow();
  });

  it("throws on a bigint", () => {
    expect(() => canonicalize({ a: 1n })).toThrow();
  });

  it("throws on a top-level bigint", () => {
    expect(() => canonicalize(1n)).toThrow();
  });

  it("throws on a function", () => {
    expect(() => canonicalize({ a: () => 1 })).toThrow();
  });

  it("throws on NaN", () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
  });

  it("throws on Infinity", () => {
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("throws on negative Infinity", () => {
    expect(() => canonicalize({ a: Number.NEGATIVE_INFINITY })).toThrow();
  });

  it("is stable across a parse/serialize round trip", () => {
    const value = { z: [3, 2, 1], a: { nested: true, list: ["x", "y"] }, n: 42, s: null };
    const once = canonicalize(value);
    const twice = canonicalize(JSON.parse(once));
    expect(twice).toBe(once);
  });
});
