function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalize: cannot serialize a non-finite number (NaN or Infinity)");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") {
    throw new Error("canonicalize: cannot serialize undefined");
  }
  if (typeof value === "bigint") {
    throw new Error("canonicalize: cannot serialize a bigint; convert it to a decimal string first");
  }
  if (typeof value === "function") {
    throw new Error("canonicalize: cannot serialize a function");
  }
  if (typeof value === "symbol") {
    throw new Error("canonicalize: cannot serialize a symbol");
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(",")}]`;
  }

  // What remains is a plain object. Sort keys lexicographically (a plain
  // string sort, not relying on JS engine key enumeration order, which
  // reorders integer-like keys ahead of insertion order) and recurse.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Serializes a value to canonical JSON: object keys sorted lexicographically
 * at every nesting level, no whitespace, array element order preserved.
 *
 * Throws on `undefined`, functions, `bigint`, and non-finite numbers
 * (`NaN`, `Infinity`, `-Infinity`), wherever they occur in the value.
 * Callers with a `bigint` (e.g. a uint256 read from chain) must convert it
 * to a decimal string before calling this function.
 *
 * These exact bytes are what gets hashed and stored onchain, so the same
 * logical value must always serialize to the same bytes.
 */
export function canonicalize(value: unknown): string {
  return serialize(value);
}
