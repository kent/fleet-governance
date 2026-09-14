import { describe, expect, it } from "vitest";
import { agoraProposalUrl } from "./links.js";

describe("agoraProposalUrl", () => {
  it("joins the base url and proposal id", () => {
    expect(agoraProposalUrl("http://localhost:3000", "42")).toBe("http://localhost:3000/proposals/42");
  });

  it("tolerates a trailing slash on the base url", () => {
    expect(agoraProposalUrl("http://localhost:3000/", "42")).toBe("http://localhost:3000/proposals/42");
  });

  it("returns null when the base url is undefined", () => {
    expect(agoraProposalUrl(undefined, "42")).toBeNull();
  });

  it("returns null when the base url is null", () => {
    expect(agoraProposalUrl(null, "42")).toBeNull();
  });

  it("returns null when the base url is an empty string", () => {
    expect(agoraProposalUrl("", "42")).toBeNull();
  });
});
