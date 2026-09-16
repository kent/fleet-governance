import { describe, expect, it } from "vitest";
import { fleetProfileVotes, fleetPublicReason } from "../src/lib/fleetProfile";
const address = "0x5b71a4c4e3e83e31d306d11079e312893b437ac5";
const row = { voter: address, proposal_id: "123", support: 0, weight: "1000000000000000000", bn: "46886054", reason: '{"rationale":"Outside the approved scope"}' };
describe("DAO Node agent profile evidence", () => {
  it("preserves the indexed ballot, reason and exact voting weight", () => {
    const votes = fleetProfileVotes({ voter_history: [row] }, address);
    expect(votes).toEqual([{ proposalId: "123", voter: address, support: 0, weight: "1000000000000000000", block: 46886054, reason: row.reason }]);
    expect(fleetPublicReason(votes[0].reason)).toBe("Outside the approved scope");
  });
  it("distinguishes missing history from an empty indexed result", () => {
    expect(() => fleetProfileVotes({}, address)).toThrow("unavailable");
    expect(fleetProfileVotes({ voter_history: [] }, address)).toEqual([]);
  });
  it("rejects another voter's record and malformed support", () => {
    expect(() => fleetProfileVotes({ voter_history: [{ ...row, voter: "0xother" }] }, address)).toThrow();
    expect(() => fleetProfileVotes({ voter_history: [{ ...row, support: 9 }] }, address)).toThrow();
  });
  it("orders by observed block and keeps non-JSON reasons", () => {
    const votes = fleetProfileVotes({ voter_history: [row, { ...row, proposal_id: "456", bn: "46886055" }] }, address);
    expect(votes.map(v => v.proposalId)).toEqual(["456", "123"]);
    expect(fleetPublicReason("Public reason")).toBe("Public reason");
  });
});
