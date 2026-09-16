import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../pipeline/activity-attestation.js", () => ({ verifyActivity: vi.fn(async () => true) }));
import { verifyActivity } from "../pipeline/activity-attestation.js";
import { verifyCollective } from "./collective-evidence.js";
const roster = JSON.parse(readFileSync("experiments/compute/agent-roster.json", "utf8"));
let input: Parameters<typeof verifyCollective>[0];
beforeEach(() => {
  vi.mocked(verifyActivity).mockResolvedValue(true);
  const activity = roster.flatMap((agent: any) => Array.from({ length: 6 }, (_, sequence) => ({ runId: "run-test", taskId: "1", chainId: 84532, agentId: agent.agentId, address: agent.address, sequence,
    previousHash: sequence ? `digest-${sequence - 1}` : `0x${"0".repeat(64)}`, digest: `digest-${sequence}`, event: { type: "work_report", checkpoint: Math.floor(sequence / 2) } })));
  input = { work: { runId: "run-test", taskId: "1", checkpoints: [{ proposalId: "1" }, { proposalId: "2" }, { proposalId: "3" }] },
    allocation: { instanceId: "7" }, state: { reason: "vote_failed", failedProposalId: "3", stopRequestedAt: 100, stopAcceptedAt: 101, stoppedAt: 120 }, vm: { id: "7", status: "TERMINATED" },
    progress: { runId: "run-test", scripted: false, activity, events: [...Array.from({ length: 2 }, () => ({ type: "checkpoint.released" })), ...Array.from({ length: 3 }, () => ({ type: "work.resumed" }))] },
    client: { listVotes: vi.fn(async () => roster.map((agent: any) => ({ voter: agent.address, support: 1, parsedReason: { rationale: "test" }, blockNumber: 1n, txHash: "0xtest" }))),
      getProposalState: vi.fn(async (id: bigint) => id === 3n ? 3 : 7), publicClient: { getBlock: vi.fn(async () => ({ timestamp: 50n })) } },
  } as unknown as Parameters<typeof verifyCollective>[0];
});
it("requires independently read ballots for all three proposals and retains every round", async () => {
  const evidence = await verifyCollective(input);
  expect(evidence.rounds.map(round => round.outcome)).toEqual(["Executed", "Executed", "Defeated"]);
  expect(evidence.verified.independentlyReadBallots).toBe(15);
  expect(input.client.listVotes).toHaveBeenCalledTimes(3);
});
it("does not certify a single early rejection as the full approval and continuation demonstration", async () => {
  input.state.failedProposalId = "1";
  await expect(verifyCollective(input)).rejects.toThrow("Incomplete collective shutdown");
});
it("rejects an altered signed claim and incomplete work history", async () => {
  vi.mocked(verifyActivity).mockResolvedValue(false);
  await expect(verifyCollective(input)).rejects.toThrow("Invalid agent evidence");
  vi.mocked(verifyActivity).mockResolvedValue(true);
  (input.progress.activity as unknown[]).pop();
  await expect(verifyCollective(input)).rejects.toThrow("Missing agent work round");
});
it("does not mistake a stop request or four votes for full acceptance", async () => {
  input.vm.status = "STOPPING";
  await expect(verifyCollective(input)).rejects.toThrow("Incomplete collective shutdown");
  input.vm.status = "TERMINATED";
  vi.mocked(input.client.listVotes).mockResolvedValue([]);
  await expect(verifyCollective(input)).rejects.toThrow("Incomplete independently verified proposal");
});
