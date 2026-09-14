import { describe, expect, it } from "vitest";
import { Address, DecimalString, Hex32, Host } from "./primitives.js";

describe("Address", () => {
  it("parses a lowercase address", () => {
    const addr = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
    expect(Address.parse(addr)).toBe(addr);
  });

  it("normalizes a mixed-case address to lowercase", () => {
    const mixed = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    expect(Address.parse(mixed)).toBe(mixed.toLowerCase());
  });

  it("rejects an address that is too short", () => {
    expect(() => Address.parse("0x1234")).toThrow();
  });

  it("rejects an address that is too long", () => {
    expect(() => Address.parse("0x" + "a".repeat(41))).toThrow();
  });

  it("rejects an address without the 0x prefix", () => {
    expect(() => Address.parse("70997970c51812dc3a010c7d01b50e0d17dc79c")).toThrow();
  });

  it("rejects an address with a non-hex character", () => {
    expect(() => Address.parse("0x" + "g".repeat(40))).toThrow();
  });
});

describe("Hex32", () => {
  it("parses a valid 32-byte hex value", () => {
    const hex = "0x" + "ab".repeat(32);
    expect(Hex32.parse(hex)).toBe(hex);
  });

  it("accepts uppercase hex digits", () => {
    const hex = "0x" + "AB".repeat(32);
    expect(Hex32.parse(hex)).toBe(hex);
  });

  it("rejects a value that is too short", () => {
    expect(() => Hex32.parse("0x1234")).toThrow();
  });

  it("rejects a value that is too long", () => {
    expect(() => Hex32.parse("0x" + "ab".repeat(33))).toThrow();
  });

  it("rejects a value without the 0x prefix", () => {
    expect(() => Hex32.parse("ab".repeat(32))).toThrow();
  });

  it("rejects a value with a non-hex character", () => {
    expect(() => Hex32.parse("0x" + "z".repeat(64))).toThrow();
  });
});

describe("DecimalString", () => {
  it("parses zero", () => {
    expect(DecimalString.parse("0")).toBe("0");
  });

  it("parses a large decimal value", () => {
    expect(DecimalString.parse("1000000000000000000")).toBe("1000000000000000000");
  });

  it("rejects a value with a leading zero", () => {
    expect(() => DecimalString.parse("01")).toThrow();
  });

  it("rejects a negative value", () => {
    expect(() => DecimalString.parse("-1")).toThrow();
  });

  it("rejects a non-numeric value", () => {
    expect(() => DecimalString.parse("abc")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => DecimalString.parse("")).toThrow();
  });
});

describe("Host", () => {
  it("parses a bare hostname", () => {
    expect(Host.parse("registry.npmjs.org")).toBe("registry.npmjs.org");
  });

  it("parses a two-label hostname", () => {
    expect(Host.parse("examples.internal")).toBe("examples.internal");
  });

  it("rejects a host with a scheme", () => {
    expect(() => Host.parse("https://registry.npmjs.org")).toThrow();
  });

  it("rejects a host with a path", () => {
    expect(() => Host.parse("registry.npmjs.org/path")).toThrow();
  });

  it("rejects a host with a port", () => {
    expect(() => Host.parse("registry.npmjs.org:443")).toThrow();
  });

  it("rejects an empty string", () => {
    expect(() => Host.parse("")).toThrow();
  });
});
