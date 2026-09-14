import { describe, it, expect } from "vitest";
import { fleetVotesAbi, taskLedgerAbi, agoraGovernorAbi, fleetHookAbi } from "./index";

describe("abi exports", () => {
  it("contain the functions the sdk relies on", () => {
    const names = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((x) => x.type === "function").map((x) => x.name);
    expect(names(taskLedgerAbi)).toEqual(
      expect.arrayContaining(["openTask", "recordDecision", "getTask", "charterText", "exceptionVersion"]),
    );
    expect(names(agoraGovernorAbi)).toEqual(
      expect.arrayContaining([
        "propose",
        "castVoteWithReason",
        "queue",
        "execute",
        "state",
        "proposalVotes",
        "quorum",
        "getProposalId",
      ]),
    );
    expect(names(fleetVotesAbi)).toEqual(expect.arrayContaining(["delegate", "getVotes", "getPastVotes", "clock"]));
    expect(names(fleetHookAbi)).toEqual(expect.arrayContaining(["actionOf", "taskOf", "decodeAction"]));
  });
});
