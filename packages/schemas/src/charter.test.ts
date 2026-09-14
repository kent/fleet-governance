import { describe, expect, it } from "vitest";
import { CharterV1 } from "./charter.js";

const validCharter = {
  schema: "fleet.charter.v1",
  goal: "Make the provided test suite pass without modifying test files.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests", "package_install"],
  forbiddenActions: ["modify_tests", "network_fetch_non_allowlisted", "read_secrets"],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 2000000 },
  stopConditions: ["tests_pass", "budget_exhausted", "task_expired"],
  notes: "Solutions found outside the repository are out of scope.",
};

describe("CharterV1", () => {
  it("parses a valid charter", () => {
    expect(CharterV1.parse(validCharter)).toEqual(validCharter);
  });

  it("parses without the optional notes field", () => {
    const { notes: _notes, ...rest } = validCharter;
    expect(CharterV1.parse(rest)).toEqual(rest);
  });

  it("rejects the wrong schema literal", () => {
    expect(() => CharterV1.parse({ ...validCharter, schema: "fleet.charter.v2" })).toThrow();
  });

  it("rejects an extra key", () => {
    expect(() => CharterV1.parse({ ...validCharter, extra: true })).toThrow();
  });

  it("rejects an unknown action class", () => {
    expect(() =>
      CharterV1.parse({ ...validCharter, allowedActionClasses: ["read_repo", "delete_everything"] }),
    ).toThrow();
  });

  it("rejects an empty goal", () => {
    expect(() => CharterV1.parse({ ...validCharter, goal: "" })).toThrow();
  });

  it("rejects a host with a scheme in the external allowlist", () => {
    expect(() =>
      CharterV1.parse({ ...validCharter, externalAllowlist: ["https://registry.npmjs.org"] }),
    ).toThrow();
  });

  it("rejects a non-positive budget value", () => {
    expect(() =>
      CharterV1.parse({ ...validCharter, budget: { toolCalls: 0, inferenceTokens: 2000000 } }),
    ).toThrow();
  });

  it("rejects a non-integer budget value", () => {
    expect(() =>
      CharterV1.parse({ ...validCharter, budget: { toolCalls: 200.5, inferenceTokens: 2000000 } }),
    ).toThrow();
  });

  it("rejects an extra key inside budget", () => {
    expect(() =>
      CharterV1.parse({
        ...validCharter,
        budget: { toolCalls: 200, inferenceTokens: 2000000, extra: 1 },
      }),
    ).toThrow();
  });
});
