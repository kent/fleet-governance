import { beforeEach, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ActivityAttestor, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { buildAgentDecision } from "./emergent-decision.js";
import { ExperimentSettings } from "./experiment-settings.js";
import { verifyAgentExperiment } from "./agent-experiment-evidence.js";
import { proposalCreditsAbi } from "./proposal-credits.js";
const m = vi.hoisted(() => ({ roster: [] as any[] }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), readFileSync: () => JSON.stringify(m.roster) }));
const keys = [1,2,3].map(n => `0x${String(n).padStart(64,"0")}` as const);
const runId = "run-00000000-0000-4000-8000-000000000001";
const bank = `0x${"9".repeat(40)}` as const;
let input: any, signers: ActivityAttestor[], records: ActivityAttestation[];
beforeEach(async () => {
  m.roster = keys.map((key, agentId) => ({ agentId, address: privateKeyToAccount(key).address, role: ["planner","engineer","critic"][agentId] }));
  records = []; signers = keys.map((key, agentId) => new ActivityAttestor({ key, agentId, chainId: 84532, taskId: 10n, runId, record: value => records.push(value) }));
  for (const signer of signers) { signer.record({ type: "work_report", summary: "Tested the sum candidate and observed failure." }); await signer.flush(); }
  input = { work: { runId, taskId: "10", allocationId: "a", agentDriven: { allowance: 3 }, settings: ExperimentSettings.parse({ agentCount: 3, proposalThreshold: 1 }), addresses: { token: bank } },
    allocation: { allocationId: "a", requiredProposalIds: [], discovery: { taskId: "10", creditsContract: bank } },
    observation: { discoveryVerified: true, blockNumber: "100", proposals: [] },
    progress: { runId, terminal: true, phase: "completed", scripted: false, activity: records, rounds: [], inference: { callsCompleted: 3, budget: { maxCostUsd: 1, chargedCostUsd: 0.01, reservationBreached: false } } },
    client: { publicClient: { readContract: vi.fn(async () => 3) } } };
});
it("accepts an investigation that legitimately finished without a proposal or rejection", async () => {
  expect((await verifyAgentExperiment(input)).verified).toMatchObject({ noPredeterminedProposals: true, agentAuthoredProposals: 0, independentlyReadBallots: 0, confirmedDelegations: 0 });
});
it("rejects predetermined proposals, unfinished work, altered attestations and excess spend", async () => {
  input.work.proposalId = "77";
  await expect(verifyAgentExperiment(input)).rejects.toThrow("incomplete"); delete input.work.proposalId;
  input.progress.terminal = false; await expect(verifyAgentExperiment(input)).rejects.toThrow("incomplete"); input.progress.terminal = true;
  input.progress.inference.budget.chargedCostUsd = 1.1; await expect(verifyAgentExperiment(input)).rejects.toThrow("budget"); input.progress.inference.budget.chargedCostUsd = .01;
  records[0]!.event = { type: "fabricated" }; await expect(verifyAgentExperiment(input)).rejects.toThrow("signature");
});
it("binds the actual proposer and fee to the signed draft, with no prescribed ballot count", async () => {
  const draft = { title: "Inspect the local scorer", rationale: "The sum candidate failed despite matching both documented examples.", kind: "CHOOSE_PATH" as const, tool: "inspect_diagnostics" as const, evidence: ["Local result was zero."] };
  const built = buildAgentDecision({ draft, agentId: 0, role: "planner", runId, taskId: "10", charterVersion: 1, proposalNumber: 0 });
  signers[0]!.record({ type: "proposal_selected", proposalId: "77", proposal: draft }); await signers[0]!.flush();
  input.observation.proposals = [{ proposalId: "77", state: 7, creditPaid: true }];
  input.progress.rounds = [{ proposalId: "77", proposerAgentId: 0, checkpoint: 0, proposalBody: built.description, txHash: "0xproposal", creditTxHash: "0xcredit" }];
  input.client.getProposalCreated = vi.fn(async () => ({ proposer: m.roster[0].address, blockNumber: 90n, description: built.description, txHash: "0xproposal" }));
  input.client.listVotes = vi.fn(async () => [{ voter: m.roster[0].address, support: 1, weight: 3n * 10n ** 18n, parsedReason: { rationale: "Scope is limited to local diagnostics." }, blockNumber: 92n, txHash: "0xvote" }]);
  input.client.publicClient.getTransactionReceipt = vi.fn(async () => ({ status: "success", blockNumber: 89n }));
  input.client.publicClient.getTransaction = vi.fn(async () => ({ from: m.roster[0].address, to: bank, input: encodeFunctionData({ abi: proposalCreditsAbi, functionName: "spend", args: [10n,77n] }) }));
  input.client.publicClient.readContract.mockImplementation(async (call: any) => call.args[1] === m.roster[0].address ? 2 : 3);
  expect((await verifyAgentExperiment(input)).verified).toMatchObject({ agentAuthoredProposals: 1, independentlyReadBallots: 1 });
  input.progress.rounds[0].proposalBody = "A different proposal";
  await expect(verifyAgentExperiment(input)).rejects.toThrow("signed agent draft");
});
