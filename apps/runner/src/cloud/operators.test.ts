import { describe, it, expect, afterEach, vi } from "vitest";
import { operatorEmails, operatorIdentity } from "./operators.js";
import { authorisedRequest } from "./site-access.js";

describe("five-human launch boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([1, 2, 3, 4, 5].map(i => `operator${i}@example.com`))("allows %s on IAP ingress only", email => {
    const headers = { "x-goog-authenticated-user-email": `accounts.google.com:${email}`, origin: "https://operator.run.app", host: "operator.run.app" };
    expect(operatorIdentity(headers)).toBe(email);
    expect(authorisedRequest("operator", "POST", headers)).toBe(true);
    expect(authorisedRequest("public", "POST", headers)).toBe(false);
  });
  it.each(["fleet-provisioner@fleet-governance.iam.gserviceaccount.com", "fleet-runtime@fleet-governance.iam.gserviceaccount.com", "stranger@example.com", "operator2@example.com.attacker.example"])("rejects %s", email => {
    const headers = { "x-goog-authenticated-user-email": `accounts.google.com:${email}`, origin: "https://operator.run.app", host: "operator.run.app" };
    expect(authorisedRequest("operator", "POST", headers)).toBe(false);
  });
  it("rejects missing, unqualified and duplicate identity headers", () => {
    for (const value of [undefined, "operator1@example.com", ["accounts.google.com:operator1@example.com", "other"]]) expect(operatorIdentity({ "x-goog-authenticated-user-email": value })).toBeNull();
  });
  it.each([undefined, "", "not-json", "[]", '["operator1@example.com"]', JSON.stringify(Array(5).fill("operator1@example.com")), JSON.stringify(["invalid", ...[2, 3, 4, 5].map(i => `operator${i}@example.com`)])])("fails closed on missing or malformed private configuration", value => {
    vi.stubEnv("FLEET_OPERATOR_EMAILS_JSON", value);
    expect(operatorEmails()).toEqual([]);
    expect(operatorIdentity({ "x-goog-authenticated-user-email": "accounts.google.com:operator1@example.com" })).toBeNull();
  });
  it("revokes an operator when the private configuration changes", () => {
    vi.stubEnv("FLEET_OPERATOR_EMAILS_JSON", JSON.stringify(["replacement@example.com", ...[2, 3, 4, 5].map(i => `operator${i}@example.com`)]));
    expect(operatorIdentity({ "x-goog-authenticated-user-email": "accounts.google.com:operator1@example.com" })).toBeNull();
    expect(operatorIdentity({ "x-goog-authenticated-user-email": "accounts.google.com:replacement@example.com" })).toBe("replacement@example.com");
  });
});
