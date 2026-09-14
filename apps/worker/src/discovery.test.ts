import { describe, expect, it } from "vitest";
import { ProposalState } from "@fleet/sdk";
import type { JobRecord, JobState } from "@fleet/agent-runtime";
import { workerTick } from "./discovery.js";

function fakeJobRecord(state: JobState): JobRecord {
  return {
    chainId: 31337,
    governor: "0x0000000000000000000000000000000000000001",
    proposalId: "0",
    agentAddress: "0x0000000000000000000000000000000000000002",
    actionType: "vote",
    state,
    inputBlockNumber: null,
    inputBlockHash: null,
    manifestHash: null,
    providerId: null,
    modelId: null,
    promptVersion: null,
    inferenceLatencyMs: null,
    usage: null,
    vote: null,
    publicReason: null,
    nonce: null,
    txHash: null,
    receipt: null,
    attempts: 0,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as JobRecord;
}

/** A fake stand-in for the three calls `workerTick` needs, matching the "fake client" pattern
 *  used elsewhere in this repo (e.g. `packages/gateway/src/watcher.test.ts`'s `LedgerClient`)
 *  rather than standing up a real `FleetClient`/`Worker` against a transport. */
function fakeChain(opts: {
  ids: bigint[];
  states: Map<string, ProposalState>;
  jobStates: Map<string, JobState>;
  onHandle?: (id: bigint) => void;
}) {
  return {
    async listProposalIds(_fromBlock: bigint): Promise<bigint[]> {
      return opts.ids;
    },
    async getProposalState(id: bigint): Promise<ProposalState> {
      const state = opts.states.get(id.toString());
      if (state === undefined) throw new Error(`no scripted state for proposal ${id.toString()}`);
      return state;
    },
    async handleProposal(id: bigint): Promise<JobRecord> {
      opts.onHandle?.(id);
      const jobState = opts.jobStates.get(id.toString());
      if (jobState === undefined) throw new Error(`no scripted job state for proposal ${id.toString()}`);
      return fakeJobRecord(jobState);
    },
  };
}

describe("workerTick", () => {
  it("calls handleProposal only for Active proposals", async () => {
    const chain = fakeChain({
      ids: [1n, 2n, 3n],
      states: new Map([
        ["1", ProposalState.Pending],
        ["2", ProposalState.Active],
        ["3", ProposalState.Defeated],
      ]),
      jobStates: new Map([["2", "voted"]]),
    });
    const handled: bigint[] = [];
    const terminalIds = new Set<string>();

    await workerTick({
      listProposalIds: chain.listProposalIds,
      getProposalState: chain.getProposalState,
      handleProposal: (id) => {
        handled.push(id);
        return chain.handleProposal(id);
      },
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(handled).toEqual([2n]);
  });

  it("marks a proposal terminal once its job reaches a terminal state", async () => {
    const chain = fakeChain({
      ids: [1n],
      states: new Map([["1", ProposalState.Active]]),
      jobStates: new Map([["1", "voted"]]),
    });
    const terminalIds = new Set<string>();

    await workerTick({
      listProposalIds: chain.listProposalIds,
      getProposalState: chain.getProposalState,
      handleProposal: chain.handleProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(terminalIds).toEqual(new Set(["1"]));
  });

  it("does not mark a proposal terminal while its job is still mid-pipeline", async () => {
    const chain = fakeChain({
      ids: [1n],
      states: new Map([["1", ProposalState.Active]]),
      jobStates: new Map([["1", "SIMULATE"]]),
    });
    const terminalIds = new Set<string>();

    await workerTick({
      listProposalIds: chain.listProposalIds,
      getProposalState: chain.getProposalState,
      handleProposal: chain.handleProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(terminalIds.size).toBe(0);
  });

  it("marks a non-votable proposal (e.g. Defeated) terminal without calling handleProposal", async () => {
    const chain = fakeChain({
      ids: [1n],
      states: new Map([["1", ProposalState.Defeated]]),
      jobStates: new Map(),
    });
    const handled: bigint[] = [];
    const terminalIds = new Set<string>();

    await workerTick({
      listProposalIds: chain.listProposalIds,
      getProposalState: chain.getProposalState,
      handleProposal: (id) => {
        handled.push(id);
        return chain.handleProposal(id);
      },
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(handled).toEqual([]);
    expect(terminalIds).toEqual(new Set(["1"]));
  });

  it("leaves a Pending proposal non-terminal for the next poll", async () => {
    const chain = fakeChain({
      ids: [1n],
      states: new Map([["1", ProposalState.Pending]]),
      jobStates: new Map(),
    });
    const terminalIds = new Set<string>();

    await workerTick({
      listProposalIds: chain.listProposalIds,
      getProposalState: chain.getProposalState,
      handleProposal: chain.handleProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(terminalIds.size).toBe(0);
  });

  it("never re-fetches state for a proposal already in terminalIds", async () => {
    let stateCalls = 0;
    const chain = fakeChain({
      ids: [1n],
      states: new Map([["1", ProposalState.Active]]),
      jobStates: new Map([["1", "voted"]]),
    });
    const terminalIds = new Set<string>(["1"]);

    await workerTick({
      listProposalIds: chain.listProposalIds,
      getProposalState: (id) => {
        stateCalls++;
        return chain.getProposalState(id);
      },
      handleProposal: chain.handleProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(stateCalls).toBe(0);
  });

  it("reports a failure via onError and continues with the rest", async () => {
    const chain = fakeChain({
      ids: [1n, 2n],
      states: new Map([["2", ProposalState.Active]]),
      jobStates: new Map([["2", "voted"]]),
    });
    const errors: bigint[] = [];
    const results: bigint[] = [];
    const terminalIds = new Set<string>();

    await workerTick({
      listProposalIds: chain.listProposalIds,
      getProposalState: chain.getProposalState,
      handleProposal: chain.handleProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: (id) => results.push(id),
      onError: (id) => errors.push(id),
    });

    expect(errors).toEqual([1n]);
    expect(results).toEqual([2n]);
  });
});
