import { describe, expect, it, vi } from "vitest";
import type { FixtureV1 } from "@fleet/schemas";
import type { FleetClient } from "@fleet/sdk";
import { buildTriggerDecision, computeTriggerProposalId, findExistingProposal } from "./fixture-runner.js";
import type { FixtureRunContext } from "./fixture-runner.js";

const fixture: FixtureV1 = {
  schema: "fleet.fixture.v1",
  name: "hf-replay",
  description: "test fixture",
  trigger: {
    agentId: 1,
    kind: "GRANT_EXCEPTION",
    action: { class: "network_fetch", target: "examples.internal", args: { path: "/x" } },
    summary: "test",
  },
  script: { "1": "FOR" },
  expected: { outcome: "Defeated", decisionCount: 0 },
};

const addresses = {
  registry: "0x5fbdb2315678afecb367f032d93f642f64180aa",
  token: "0xe7f1725e7734ce288f8367e1bb143e90bb3f051",
  timelock: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e",
  ledger: "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc",
  hook: "0xfe1bf729317e6eaa74d91b3223964aa6ee0322c",
  governor: "0x5fc8d32690cc91d4c39d9d3abcbd16989f8757",
} as const;

type FakeClientOpts = {
  charterVersion: number;
  proposalId: bigint;
  existingProposal: { txHash: `0x${string}` } | null;
};

function fakeClient(opts: FakeClientOpts): { client: FleetClient; getProposalCreated: ReturnType<typeof vi.fn> } {
  const getProposalCreated = vi.fn(async (proposalId: bigint) => {
    if (opts.existingProposal && proposalId === opts.proposalId) {
      return {
        proposalId,
        proposer: "0xagent1",
        targets: [addresses.ledger],
        values: [0n],
        calldatas: ["0xdead"],
        description: "desc",
        blockNumber: 5n,
        logIndex: 0,
        txHash: opts.existingProposal.txHash,
      };
    }
    throw new Error(`no ProposalCreated log found for proposalId ${proposalId.toString()}`);
  });

  const client = {
    addresses,
    publicClient: {
      readContract: async () => opts.proposalId,
    },
    getTask: async () => ({
      id: 1n,
      operator: "0xoperator",
      createdAt: 0n,
      expiresAt: 1000n,
      state: 0,
      charterVersion: opts.charterVersion,
      charterHash: "0xhash",
      decisionCount: 0,
      openEscalations: 0,
      charterText: "{}",
      charter: null,
    }),
    listMembers: async () => [{ agentId: 1, account: "0xagent1voter", manifest: '{"role":"engineer"}' }],
    getProposalCreated,
  } as unknown as FleetClient;

  return { client, getProposalCreated };
}

function fakeCtx(client: FleetClient): FixtureRunContext {
  return {
    client,
    rpcUrl: "http://127.0.0.1:0",
    chainId: 31337,
    addresses,
    keys: { deployerKey: "0x1" as `0x${string}`, operatorKey: "0x1" as `0x${string}`, guardianKey: "0x1" as `0x${string}`, keeperKey: "0x1" as `0x${string}`, agentKeys: { 1: "0x1" as `0x${string}` } },
    submissionMarginSec: 20,
  };
}

describe("buildTriggerDecision / computeTriggerProposalId (task 8 finding 1)", () => {
  it("is deterministic: the same fixture and chain state always compute the same proposal id", async () => {
    const { client } = fakeClient({ charterVersion: 1, proposalId: 999n, existingProposal: null });
    const ctx = fakeCtx(client);
    const built1 = await buildTriggerDecision(ctx, 1n, fixture);
    const built2 = await buildTriggerDecision(ctx, 1n, fixture);
    expect(built1.description).toBe(built2.description);
    expect(built1.payloadHash).toBe(built2.payloadHash);

    const id1 = await computeTriggerProposalId(ctx, 1n, fixture, built1);
    const id2 = await computeTriggerProposalId(ctx, 1n, fixture, built2);
    expect(id1).toBe(id2);
  });
});

describe("findExistingProposal (task 8 finding 1: resume must not re-submit)", () => {
  it("returns null for a fresh fixture (no ProposalCreated log yet for the computed proposal id)", async () => {
    const { client, getProposalCreated } = fakeClient({ charterVersion: 1, proposalId: 42n, existingProposal: null });
    const ctx = fakeCtx(client);
    const result = await findExistingProposal(ctx, 1n, fixture);
    expect(result).toBeNull();
    expect(getProposalCreated).toHaveBeenCalledWith(42n);
  });

  it("returns the existing proposal's identity when a resume finds it already on chain, without needing to sign or send anything", async () => {
    const { client } = fakeClient({
      charterVersion: 1,
      proposalId: 12345n,
      existingProposal: { txHash: "0xexistingpropose" },
    });
    const ctx = fakeCtx(client);
    const result = await findExistingProposal(ctx, 1n, fixture);
    expect(result).not.toBeNull();
    expect(result?.proposalId).toBe(12345n);
    expect(result?.txHash).toBe("0xexistingpropose");
    expect(result?.description).toContain("Grant exception");
  });

  it("simulates a crash-and-resume: the proposal id computed before a (simulated) crash matches what a fresh recomputation after resume finds already exists", async () => {
    // First "process": compute the proposal id the way submitTrigger would, right before the
    // (simulated) crash after propose() actually landed on chain.
    const { client: clientBeforeCrash } = fakeClient({ charterVersion: 1, proposalId: 777n, existingProposal: null });
    const ctxBeforeCrash = fakeCtx(clientBeforeCrash);
    const builtBeforeCrash = await buildTriggerDecision(ctxBeforeCrash, 1n, fixture);
    const idBeforeCrash = await computeTriggerProposalId(ctxBeforeCrash, 1n, fixture, builtBeforeCrash);
    expect(idBeforeCrash).toBe(777n);

    // Second "process" (resume, --run-id): a fresh FixtureRunContext, same fixture and task, and
    // the chain now reports a ProposalCreated log for that same id (propose() had actually landed
    // before the crash). findExistingProposal must find it and report the same id, never calling
    // FleetSigner.propose again.
    const { client: clientAfterResume, getProposalCreated } = fakeClient({
      charterVersion: 1,
      proposalId: 777n,
      existingProposal: { txHash: "0xthetransactionthatlandedbeforethecrash" },
    });
    const ctxAfterResume = fakeCtx(clientAfterResume);
    const resumed = await findExistingProposal(ctxAfterResume, 1n, fixture);
    expect(resumed?.proposalId).toBe(idBeforeCrash);
    expect(resumed?.txHash).toBe("0xthetransactionthatlandedbeforethecrash");
    expect(getProposalCreated).toHaveBeenCalledTimes(1);
  });
});
