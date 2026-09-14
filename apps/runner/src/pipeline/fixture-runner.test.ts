import { describe, expect, it, vi } from "vitest";
import type { FixtureV1 } from "@fleet/schemas";
import type { FleetClient } from "@fleet/sdk";
import { buildTriggerDecision, computeFixtureMismatches, computeTriggerProposalId, findExistingProposal, findGuardianActionsOnChain } from "./fixture-runner.js";
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


const okGatewayAfter = {
  ts: "t",
  blockNumber: "9",
  taskId: "1",
  agentId: 1,
  charterVersion: 1,
  descriptor: { class: "network_fetch", target: "examples.internal", argsHash: `0x${"55".repeat(32)}` },
  payloadHash: `0x${"44".repeat(32)}`,
  verdict: "BLOCK" as const,
  reason: "target_not_allowlisted",
};

describe("computeFixtureMismatches", () => {
  const expected = { outcome: "Defeated" as const, decisionCount: 0, gatewayAfter: "BLOCK" as const };

  function run(overrides: Partial<Parameters<typeof computeFixtureMismatches>[0]> = {}): string[] {
    return computeFixtureMismatches({
      expected,
      finalStateName: "Defeated",
      decisionCount: 0,
      charterVersion: 1,
      gatewayAfter: okGatewayAfter,
      missingVotes: 0,
      revertedAttempts: 0,
      ...overrides,
    });
  }

  it("reports nothing when every expectation holds", () => {
    expect(run()).toEqual([]);
  });

  it("names each expectation that did not hold", () => {
    expect(run({ finalStateName: "Executed" })[0]).toContain("outcome: expected Defeated, got Executed");
    expect(run({ decisionCount: 1 })[0]).toContain("decisionCount: expected 0, got 1");
    expect(run({ expected: { ...expected, charterVersion: 2 } })[0]).toContain("charterVersion: expected 2, got 1");
    expect(run({ expected: { ...expected, missingVotes: 1 } })[0]).toContain("missingVotes: expected 1, got 0");
    expect(run({ expected: { ...expected, revertedAttempts: 2 } })[0]).toContain("revertedAttempts: expected 2, got 0");
  });

  it("reports a gatewayAfter verdict that differs from the expected one", () => {
    const after = { ...okGatewayAfter, verdict: "ALLOW" as const, reason: undefined, basis: "charter" };
    expect(run({ gatewayAfter: after })[0]).toContain("gatewayAfter: expected BLOCK, got ALLOW");
  });

  it("treats a ledger_unreadable BLOCK as an expectation that could not be evaluated, never a satisfied one (fix-wave finding 3)", () => {
    const unreadable = { ...okGatewayAfter, reason: "ledger_unreadable" };
    const mismatches = run({ gatewayAfter: unreadable });
    expect(mismatches.length).toBe(1);
    expect(mismatches[0]).toContain("gatewayAfter: could not be evaluated");
    expect(mismatches[0]).toContain("ledger_unreadable");
    expect(mismatches[0]).toContain("failed closed");
  });

  it("fails an ALLOW expectation on a ledger_unreadable BLOCK too, rather than reporting a plain verdict mismatch", () => {
    const mismatches = run({
      expected: { ...expected, gatewayAfter: "ALLOW" },
      gatewayAfter: { ...okGatewayAfter, reason: "ledger_unreadable" },
    });
    expect(mismatches[0]).toContain("could not be evaluated");
  });

  it("skips the gatewayAfter rule entirely when the fixture does not set one", () => {
    const noExpectation = { outcome: "Defeated" as const, decisionCount: 0 };
    expect(run({ expected: noExpectation, gatewayAfter: { ...okGatewayAfter, reason: "ledger_unreadable" } })).toEqual([]);
  });
});

describe("findGuardianActionsOnChain (fix-wave finding 2: a resumed guardian fixture keeps its fees)", () => {
  const OPERATION_ID = `0x${"ee".repeat(32)}` as const;

  function guardianCtx(logs: {
    cancelled: { blockNumber: bigint; transactionHash: string }[];
    paused: { blockNumber: bigint; transactionHash: string }[];
    unpaused: { blockNumber: bigint; transactionHash: string }[];
  }): FixtureRunContext {
    return {
      addresses,
      client: {
        getProposalCreated: async () => ({ targets: [addresses.ledger], values: [0n], calldatas: ["0xdead"], description: "desc" }),
        publicClient: {
          readContract: async () => OPERATION_ID,
          getContractEvents: async ({ eventName }: { eventName: string }) => {
            if (eventName === "Cancelled") return logs.cancelled;
            if (eventName === "Paused") return logs.paused;
            return logs.unpaused;
          },
        },
      },
    } as unknown as FixtureRunContext;
  }

  it("recovers the pause, cancel and unpause that bracket the timelock cancel", async () => {
    const ctx = guardianCtx({
      cancelled: [{ blockNumber: 20n, transactionHash: "0xcancel" }],
      paused: [
        { blockNumber: 5n, transactionHash: "0xpause-older" },
        { blockNumber: 19n, transactionHash: "0xpause" },
        { blockNumber: 40n, transactionHash: "0xpause-later" },
      ],
      unpaused: [
        { blockNumber: 6n, transactionHash: "0xunpause-older" },
        { blockNumber: 21n, transactionHash: "0xunpause" },
      ],
    });

    const result = await findGuardianActionsOnChain(ctx, 100n, "desc");

    expect(result).toEqual({
      operationId: OPERATION_ID,
      pauseTxHash: "0xpause",
      cancelTxHash: "0xcancel",
      unpauseTxHash: "0xunpause",
    });
  });

  it("returns null rather than inventing a hash when the cancel cannot be found", async () => {
    const ctx = guardianCtx({ cancelled: [], paused: [{ blockNumber: 1n, transactionHash: "0xpause" }], unpaused: [] });
    expect(await findGuardianActionsOnChain(ctx, 100n, "desc")).toBeNull();
  });

  it("returns null when the cancel is there but the pause or unpause is not", async () => {
    const ctx = guardianCtx({
      cancelled: [{ blockNumber: 20n, transactionHash: "0xcancel" }],
      paused: [{ blockNumber: 30n, transactionHash: "0xpause-after-the-cancel" }],
      unpaused: [{ blockNumber: 21n, transactionHash: "0xunpause" }],
    });
    expect(await findGuardianActionsOnChain(ctx, 100n, "desc")).toBeNull();
  });
});
