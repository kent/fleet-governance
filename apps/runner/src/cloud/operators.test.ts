import { describe, it, expect } from "vitest";
import { OPERATOR_EMAILS, operatorIdentity } from "./operators.js";
import { authorisedRequest } from "./site-access.js";

describe("five-human launch boundary", () => {
  it.each(OPERATOR_EMAILS)("allows %s on IAP ingress only", email => {
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
});
