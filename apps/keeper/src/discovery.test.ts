import { describe, expect, it } from "vitest";
import type { KeeperResult } from "@fleet/sdk";
import { keeperTick } from "./discovery.js";

/** A fake stand-in for the pair of calls `keeperTick` needs: listing proposal ids and
 *  reconciling one. Mirrors the "fake client" pattern used elsewhere in this repo (e.g.
 *  `packages/gateway/src/watcher.test.ts`'s `LedgerClient`) rather than standing up a real
 *  `FleetClient`/`Keeper` against a transport. */
function fakeChain(opts: {
  ids: bigint[];
  results: Map<string, KeeperResult>;
  onReconcile?: (id: bigint) => void;
}) {
  return {
    async listProposalIds(_fromBlock: bigint): Promise<bigint[]> {
      return opts.ids;
    },
    async reconcileProposal(id: bigint): Promise<KeeperResult> {
      opts.onReconcile?.(id);
      const result = opts.results.get(id.toString());
      if (!result) throw new Error(`no scripted result for proposal ${id.toString()}`);
      return result;
    },
  };
}

describe("keeperTick", () => {
  it("reconciles every discovered id and reports each result", async () => {
    const chain = fakeChain({
      ids: [1n, 2n],
      results: new Map([
        ["1", "noop"],
        ["2", "queued"],
      ]),
    });
    const results: Array<{ id: bigint; result: KeeperResult }> = [];
    const terminalIds = new Set<string>();

    await keeperTick({
      listProposalIds: chain.listProposalIds,
      reconcileProposal: chain.reconcileProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: (id, result) => results.push({ id, result }),
      onError: () => expect.unreachable("no error expected"),
    });

    expect(results).toEqual([
      { id: 1n, result: "noop" },
      { id: 2n, result: "queued" },
    ]);
    expect(terminalIds.size).toBe(0);
  });

  it("adds executed, defeated, and canceled proposals to terminalIds", async () => {
    const chain = fakeChain({
      ids: [1n, 2n, 3n],
      results: new Map([
        ["1", "executed"],
        ["2", "defeated"],
        ["3", "canceled"],
      ]),
    });
    const terminalIds = new Set<string>();

    await keeperTick({
      listProposalIds: chain.listProposalIds,
      reconcileProposal: chain.reconcileProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(terminalIds).toEqual(new Set(["1", "2", "3"]));
  });

  it("never re-reconciles a proposal already in terminalIds", async () => {
    let calls = 0;
    const chain = fakeChain({
      ids: [1n, 2n],
      results: new Map([
        ["1", "noop"],
        ["2", "noop"],
      ]),
      onReconcile: () => {
        calls++;
      },
    });
    const terminalIds = new Set<string>(["1"]);

    await keeperTick({
      listProposalIds: chain.listProposalIds,
      reconcileProposal: chain.reconcileProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: () => {},
      onError: () => expect.unreachable("no error expected"),
    });

    expect(calls).toBe(1);
  });

  it("reports a reconcile failure via onError and continues with the rest", async () => {
    const chain = fakeChain({
      ids: [1n, 2n],
      results: new Map([["2", "executed"]]),
    });
    const errors: bigint[] = [];
    const results: bigint[] = [];
    const terminalIds = new Set<string>();

    await keeperTick({
      listProposalIds: chain.listProposalIds,
      reconcileProposal: chain.reconcileProposal,
      fromBlock: 0n,
      terminalIds,
      onResult: (id) => results.push(id),
      onError: (id) => errors.push(id),
    });

    expect(errors).toEqual([1n]);
    expect(results).toEqual([2n]);
    expect(terminalIds).toEqual(new Set(["2"]));
  });

  it("passes fromBlock through to listProposalIds", async () => {
    let seen: bigint | undefined;
    await keeperTick({
      listProposalIds: async (fromBlock) => {
        seen = fromBlock;
        return [];
      },
      reconcileProposal: async () => "noop",
      fromBlock: 42n,
      terminalIds: new Set(),
      onResult: () => {},
      onError: () => {},
    });
    expect(seen).toBe(42n);
  });
});
