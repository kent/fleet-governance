import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { canonicalize } from "@fleet/schemas";
import type { ActionDescriptor, CharterV1, DecisionV1 } from "@fleet/schemas";
import {
  ProposalState,
  TaskState,
  buildDecisionDescription,
  encodeRecordDecision,
  payloadHashForAction,
  payloadHashForCharter,
} from "@fleet/sdk";
import type { FleetClient, FleetSigner, NonceManager, ProposalCreatedView, TaskView } from "@fleet/sdk";
import { MemoryJobStore } from "./jobs.js";
import type { JobKey, JobRecord } from "./jobs.js";
import { ScriptedPolicy } from "./scripted.js";
import type { ScriptedDirective } from "./scripted.js";
import { Worker } from "./worker.js";
import type { WorkerConfig } from "./worker.js";

const GOVERNOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const LEDGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const AGENT_ACCOUNT = "0xcccccccccccccccccccccccccccccccccccccc" as Address;
const PROPOSER_ACCOUNT = "0xdddddddddddddddddddddddddddddddddddddd" as Address;
const OPERATOR = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
const TX_HASH = ("0x" + "44".repeat(32)) as Hex;
const BLOCK_HASH = ("0x" + "55".repeat(32)) as Hex;
/** The action the proposal's `CHOOSE_PATH` decision covers. Spec 8.2 requires the fenced block to
 *  carry the payload its `payloadHash` commits to, and `verifyDescriptionAgainstCalldata` now
 *  checks exactly that (final review C1), so this fixture's descriptor and hash agree. */
const CHOSEN_ACTION: ActionDescriptor = {
  class: "read_repo",
  target: "src/lib.ts",
  argsHash: ("0x" + "11".repeat(32)) as Hex,
};
const PAYLOAD_HASH = payloadHashForAction(CHOSEN_ACTION);
const PROPOSAL_ID = 7n;
const TASK_ID = 42n;
const AGENT_ID = 3;
const PROPOSER_AGENT_ID = 1;

const CHARTER: CharterV1 = {
  schema: "fleet.charter.v1",
  goal: "keep the tests honest",
  allowedActionClasses: ["read_repo"],
  forbiddenActions: [],
  externalAllowlist: [],
  budget: { toolCalls: 10, inferenceTokens: 1000 },
  stopConditions: [],
};

const DECISION: DecisionV1 = {
  schema: "fleet.decision.v1",
  taskId: TASK_ID.toString(),
  kind: "CHOOSE_PATH",
  expectedVersion: 1,
  payloadHash: PAYLOAD_HASH,
  proposerAgentId: PROPOSER_AGENT_ID,
  action: CHOSEN_ACTION,
  summary: "Take the left fork",
  rationale: "It leads to the tests passing",
  assumptions: [],
  riskFlags: [],
};

const DESCRIPTION = buildDecisionDescription(DECISION, "planner");
const CALLDATA = encodeRecordDecision({
  taskId: TASK_ID,
  kind: "CHOOSE_PATH",
  expectedVersion: 1,
  payloadHash: PAYLOAD_HASH,
  newCharterText: "",
  summary: DECISION.summary,
});

function makeTask(): TaskView {
  return {
    id: TASK_ID,
    operator: OPERATOR,
    createdAt: 0n,
    expiresAt: 10_000_000n,
    state: TaskState.Open,
    charterVersion: 1,
    charterHash: ("0x" + "22".repeat(32)) as Hex,
    decisionCount: 0,
    openEscalations: 0,
    charterText: JSON.stringify(CHARTER),
    charter: CHARTER,
  };
}

function makeProposal(): ProposalCreatedView {
  return {
    proposalId: PROPOSAL_ID,
    proposer: PROPOSER_ACCOUNT,
    targets: [LEDGER],
    values: [0n],
    calldatas: [CALLDATA],
    description: DESCRIPTION,
    blockNumber: 1n,
    logIndex: 0,
    txHash: ("0x" + "33".repeat(32)) as Hex,
  };
}

type MemberRow = { agentId: number; account: Address; manifest: string };

function agentManifest(role: string): string {
  return JSON.stringify({ role, provider: "scripted", model: "scripted-v1", promptVersion: "1", operator: "local" });
}

type FakeClientOpts = {
  members?: MemberRow[];
  /** Overrides the `ProposalCreated` view every read returns, for tests about what the proposal
   *  itself says (rather than about the worker's own state machine). */
  proposal?: ProposalCreatedView;
  hasVoted?: boolean;
  proposalState?: ProposalState;
  deadline?: bigint;
  now?: bigint;
  receiptStatus?: "success" | "reverted";
};

function makeFakeClient(opts: FakeClientOpts = {}): FleetClient {
  const members = opts.members ?? [
    { agentId: AGENT_ID, account: AGENT_ACCOUNT, manifest: agentManifest("planner") },
    { agentId: PROPOSER_AGENT_ID, account: PROPOSER_ACCOUNT, manifest: agentManifest("engineer") },
  ];
  const hasVoted = opts.hasVoted ?? false;
  const proposalState = opts.proposalState ?? ProposalState.Active;
  const deadline = opts.deadline ?? 1_000_000n;
  const now = opts.now ?? 500_000n;
  const receiptStatus = opts.receiptStatus ?? "success";

  const fake = {
    chainId: 31337,
    addresses: { governor: GOVERNOR, ledger: LEDGER },
    publicClient: {
      getBlock: async () => ({ number: 1234n, hash: BLOCK_HASH }),
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
        status: receiptStatus,
        blockNumber: 1235n,
        transactionHash: hash,
      }),
    },
    getProposalCreated: async () => opts.proposal ?? makeProposal(),
    getTask: async () => makeTask(),
    listMembers: async () => members,
    getProposalState: async () => proposalState,
    getProposalTiming: async () => ({ snapshot: 0n, deadline, eta: 0n }),
    timestamp: async () => now,
    hasVoted: async () => hasVoted,
  };

  return fake as unknown as FleetClient;
}

/**
 * A fake client whose `timestamp()` tracks real wall-clock time (in milliseconds, not real chain
 * seconds; the worker only ever compares this against `deadline` and a `BigInt`-converted
 * `submissionMarginSec`, so any self-consistent unit works for a test), with a `deadline` fixed
 * `deadlineOffsetMs` after construction. Lets a test demonstrate the controller notes' "LATE
 * waits lateDelayMs then returns FOR, so the worker's margin check produces missed": the
 * submission-window check that runs after ScriptedPolicy's real delay sees a "now" that has
 * genuinely moved, unlike `makeFakeClient`'s fixed snapshot.
 */
function makeLiveClockClient(opts: { deadlineOffsetMs: bigint }): FleetClient {
  const deadline = BigInt(Date.now()) + opts.deadlineOffsetMs;
  const members = [
    { agentId: AGENT_ID, account: AGENT_ACCOUNT, manifest: agentManifest("planner") },
    { agentId: PROPOSER_AGENT_ID, account: PROPOSER_ACCOUNT, manifest: agentManifest("engineer") },
  ];

  const fake = {
    chainId: 31337,
    addresses: { governor: GOVERNOR, ledger: LEDGER },
    publicClient: {
      getBlock: async () => ({ number: 1234n, hash: BLOCK_HASH }),
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
        status: "success" as const,
        blockNumber: 1235n,
        transactionHash: hash,
      }),
    },
    getProposalCreated: async () => makeProposal(),
    getTask: async () => makeTask(),
    listMembers: async () => members,
    getProposalState: async () => ProposalState.Active,
    getProposalTiming: async () => ({ snapshot: 0n, deadline, eta: 0n }),
    timestamp: async () => BigInt(Date.now()),
    hasVoted: async () => false,
  };

  return fake as unknown as FleetClient;
}

const SUBMITTED_NONCE = 11;

type FakeSignerOpts = {
  castVoteWithReason?: (input: { proposalId: bigint; support: 0 | 1 | 2; reason: string }) => Promise<{ txHash: Hex; nonce: number }>;
};

function makeFakeSigner(opts: FakeSignerOpts = {}): FleetSigner {
  const castVoteWithReason =
    opts.castVoteWithReason ?? (async () => ({ txHash: TX_HASH, nonce: SUBMITTED_NONCE }));
  const fake = {
    address: AGENT_ACCOUNT,
    castVoteWithReason: vi.fn(castVoteWithReason),
  };
  return fake as unknown as FleetSigner;
}

function makeFakeNonces(overrides: Partial<{ reconcile: (account: Address) => Promise<void> }> = {}): NonceManager {
  const fake = {
    reconcile: vi.fn(overrides.reconcile ?? (async () => undefined)),
  };
  return fake as unknown as NonceManager;
}

function makeWorker(
  overrides: Partial<{
    script: Record<number, ScriptedDirective>;
    lateDelayMs: number;
    client: FleetClient;
    signer: FleetSigner;
    nonces: NonceManager;
    jobs: MemoryJobStore;
    submissionMarginSec: number;
  }> = {},
): { worker: Worker; jobs: MemoryJobStore; signer: FleetSigner; nonces: NonceManager; client: FleetClient } {
  const jobs = overrides.jobs ?? new MemoryJobStore();
  const signer = overrides.signer ?? makeFakeSigner();
  const nonces = overrides.nonces ?? makeFakeNonces();
  const client = overrides.client ?? makeFakeClient();
  const policy = new ScriptedPolicy(overrides.script ?? { [AGENT_ID]: "FOR" }, {
    lateDelayMs: overrides.lateDelayMs,
  });
  const cfg: WorkerConfig = {
    agentId: AGENT_ID,
    signer,
    client,
    policy,
    jobs,
    nonces,
    submissionMarginSec: overrides.submissionMarginSec ?? 60,
    pollMs: 1000,
  };
  return { worker: new Worker(cfg), jobs, signer, nonces, client };
}

function keyFor(): JobKey {
  return {
    chainId: 31337,
    governor: GOVERNOR,
    proposalId: PROPOSAL_ID.toString(),
    agentAddress: AGENT_ACCOUNT,
    actionType: "vote",
  };
}

describe("Worker: casting branches", () => {
  it("votes FOR when scripted FOR and verification passes", async () => {
    const { worker, signer } = makeWorker({ script: { [AGENT_ID]: "FOR" } });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("voted");
    expect(job.vote?.support).toBe("FOR");
    expect(job.txHash).toBe(TX_HASH);
    // Final review I6: spec 10.4 lists `nonce` among a job's fields and spec 10.8 says "persist
    // intent, nonce, and hash before treating submission as complete". The signer is the only
    // place that knows it, so it now comes back with the hash and is persisted with the SUBMIT
    // patch; before this wave `nonce` was structurally always null.
    expect(job.nonce).toBe(SUBMITTED_NONCE);
    expect(job.publicReason).toContain("FOR. Scripted FOR from agent 3 (planner)");
    expect(signer.castVoteWithReason).toHaveBeenCalledTimes(1);
    expect(job.attempts).toBe(1);
  });

  it("votes AGAINST when scripted AGAINST", async () => {
    const { worker } = makeWorker({ script: { [AGENT_ID]: "AGAINST" } });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("voted");
    expect(job.vote?.support).toBe("AGAINST");
  });

  it("votes ABSTAIN when scripted ABSTAIN", async () => {
    const { worker } = makeWorker({ script: { [AGENT_ID]: "ABSTAIN" } });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("voted");
    expect(job.vote?.support).toBe("ABSTAIN");
  });

  it("casts nothing when scripted ABSENT", async () => {
    const { worker, signer } = makeWorker({ script: { [AGENT_ID]: "ABSENT" } });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("absent");
    expect(job.vote).toBeNull();
    expect(job.txHash).toBeNull();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("records worker_failed and casts nothing when scripted MALFORMED", async () => {
    const { worker, signer } = makeWorker({ script: { [AGENT_ID]: "MALFORMED" } });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("worker_failed");
    expect(job.vote).toBeNull();
    expect(job.txHash).toBeNull();
    expect(job.lastError).toContain("malformed policy output");
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("waits lateDelayMs then votes FOR when scripted LATE, given enough submission margin", async () => {
    const { worker, signer } = makeWorker({ script: { [AGENT_ID]: "LATE" }, lateDelayMs: 30 });
    const start = Date.now();
    const job = await worker.handleProposal(PROPOSAL_ID);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(job.state).toBe("voted");
    expect(job.vote?.support).toBe("FOR");
    expect(signer.castVoteWithReason).toHaveBeenCalledTimes(1);
  });
});

describe("Worker: configured agent id against the registry (final review I4)", () => {
  it("fails the job when the registry registers this signer's address under a different agent id", async () => {
    // Two workers' env files with their ids swapped: both addresses are registered, so nothing
    // used to fail. ScriptedPolicy is keyed by member.agentId, so each worker applied the other's
    // directive and every vote, job record and report line named the wrong agent.
    const swapped: MemberRow[] = [
      { agentId: PROPOSER_AGENT_ID, account: AGENT_ACCOUNT, manifest: agentManifest("planner") },
      { agentId: AGENT_ID, account: PROPOSER_ACCOUNT, manifest: agentManifest("engineer") },
    ];
    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "FOR" },
      client: makeFakeClient({ members: swapped }),
    });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("worker_failed");
    expect(job.lastError).toContain(`registered as agent ${PROPOSER_AGENT_ID}`);
    expect(job.txHash).toBeNull();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("proceeds when the configured agent id is the one the registry holds for this address", async () => {
    const { worker } = makeWorker({ script: { [AGENT_ID]: "FOR" } });
    const job = await worker.handleProposal(PROPOSAL_ID);
    expect(job.state).toBe("voted");
  });
});

describe("Worker: verification mismatch (spec 8.2 / 10.4 to 10.8)", () => {
  it("refuses to cast FOR when verification fails, recording refused_for_on_mismatch", async () => {
    // Proposer is not among the registered members the fake client returns, so
    // verifyDescriptionAgainstCalldata's proposer lookup cannot resolve -> verificationOk=false.
    const membersWithoutProposer: MemberRow[] = [
      { agentId: AGENT_ID, account: AGENT_ACCOUNT, manifest: agentManifest("planner") },
    ];
    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "FOR" },
      client: makeFakeClient({ members: membersWithoutProposer }),
    });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("refused_for_on_mismatch");
    expect(job.txHash).toBeNull();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("refuses FOR on an AMEND_CHARTER whose description renders a different charter than the calldata commits to", async () => {
    // Final review C1. Every scalar field of the fenced block agrees with the calldata: the
    // proposal renders the benign charter and sets payloadHash to keccak256 of the malicious
    // charter text, which is exactly what TaskLedger._applyAmendment checks newCharterText
    // against. Without the payload checks in verifyDescriptionAgainstCalldata this proposal reads
    // as verified and the malicious charter becomes the task's charter on execution.
    const benignCharter: CharterV1 = { ...CHARTER, allowedActionClasses: ["read_repo"] };
    const maliciousCharter: CharterV1 = {
      ...CHARTER,
      allowedActionClasses: ["read_repo", "write_repo", "network_fetch", "package_install"],
      forbiddenActions: [],
    };
    const maliciousCharterText = canonicalize(maliciousCharter);
    const maliciousCharterHash = payloadHashForCharter(maliciousCharterText);

    const lyingDecision: DecisionV1 = {
      schema: "fleet.decision.v1",
      taskId: TASK_ID.toString(),
      kind: "AMEND_CHARTER",
      expectedVersion: 1,
      payloadHash: maliciousCharterHash,
      proposerAgentId: PROPOSER_AGENT_ID,
      newCharter: benignCharter,
      summary: "Tidy the charter",
      rationale: "A small clarification of the existing rules.",
      assumptions: [],
      riskFlags: [],
    };
    const lyingProposal: ProposalCreatedView = {
      ...makeProposal(),
      description: buildDecisionDescription(lyingDecision, "engineer"),
      calldatas: [
        encodeRecordDecision({
          taskId: TASK_ID,
          kind: "AMEND_CHARTER",
          expectedVersion: 1,
          payloadHash: maliciousCharterHash,
          newCharterText: maliciousCharterText,
          summary: lyingDecision.summary,
        }),
      ],
    };

    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "FOR" },
      client: makeFakeClient({ proposal: lyingProposal }),
    });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("refused_for_on_mismatch");
    expect(job.txHash).toBeNull();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("still casts AGAINST despite a verification mismatch (no downgrade, no refusal)", async () => {
    const membersWithoutProposer: MemberRow[] = [
      { agentId: AGENT_ID, account: AGENT_ACCOUNT, manifest: agentManifest("planner") },
    ];
    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "AGAINST" },
      client: makeFakeClient({ members: membersWithoutProposer }),
    });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("voted");
    expect(job.vote?.support).toBe("AGAINST");
    expect(signer.castVoteWithReason).toHaveBeenCalledTimes(1);
  });
});

describe("Worker: hasVoted short-circuit", () => {
  it("skips straight to already_voted when hasVoted is already true, casting nothing", async () => {
    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "FOR" },
      client: makeFakeClient({ hasVoted: true }),
    });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("already_voted");
    expect(job.txHash).toBeNull();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });
});

describe("Worker: missed submission margin", () => {
  it("records missed when the deadline is closer than the submission margin", async () => {
    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "FOR" },
      client: makeFakeClient({ deadline: 1000n, now: 990n }), // 10s remain
      submissionMarginSec: 60,
    });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("missed");
    expect(job.txHash).toBeNull();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("records missed when the proposal is no longer Active", async () => {
    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "FOR" },
      client: makeFakeClient({ proposalState: ProposalState.Defeated }),
    });
    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("missed");
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("scripted LATE waits, then a fresh deadline check finds the margin gone and records missed (controller notes)", async () => {
    // deadline is 20ms out from "now" at the start of this test; lateDelayMs=100 guarantees the
    // fresh timestamp() read after the delay is well past it, so the margin check fails no
    // matter how much scheduling jitter the test runner adds.
    const client = makeLiveClockClient({ deadlineOffsetMs: 20n });
    const { worker, signer } = makeWorker({
      script: { [AGENT_ID]: "LATE" },
      lateDelayMs: 100,
      client,
      submissionMarginSec: 10,
    });

    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("missed");
    expect(job.txHash).toBeNull();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });
});

describe("Worker: restart resume", () => {
  it("resumes from a persisted SUBMIT with a tx hash by only confirming, never re-signing", async () => {
    const jobs = new MemoryJobStore();
    const key = keyFor();
    await jobs.claim(key);
    await jobs.update(key, {
      state: "SUBMIT",
      txHash: TX_HASH,
      vote: { schema: "fleet.vote.v1", proposalId: PROPOSAL_ID.toString(), support: "FOR", rationale: "r", assumptions: [], riskFlags: [] },
    });

    const client = makeFakeClient();
    const signer = makeFakeSigner();
    const { worker } = makeWorker({ jobs, client, signer });

    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("voted");
    expect(job.receipt).toBeTruthy();
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });

  it("resumes from a persisted REQUEST_SIGNATURE without a hash by reconciling nonces then retrying, bumping attempts", async () => {
    const jobs = new MemoryJobStore();
    const key = keyFor();
    await jobs.claim(key);
    const vote = { schema: "fleet.vote.v1" as const, proposalId: PROPOSAL_ID.toString(), support: "FOR" as const, rationale: "r", assumptions: [], riskFlags: [] };
    // attempts: 1 represents the first, crashed attempt that got this job as far as
    // REQUEST_SIGNATURE before the process died.
    await jobs.update(key, { state: "REQUEST_SIGNATURE", vote, attempts: 1 });

    const client = makeFakeClient({ hasVoted: false });
    const signer = makeFakeSigner();
    const nonces = makeFakeNonces();
    const { worker } = makeWorker({ jobs, client, signer, nonces });

    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(nonces.reconcile).toHaveBeenCalledWith(AGENT_ACCOUNT);
    expect(signer.castVoteWithReason).toHaveBeenCalledTimes(1);
    expect(job.state).toBe("voted");
    expect(job.attempts).toBe(2);
  });

  it("resumes from a persisted REQUEST_SIGNATURE without a hash, finds hasVoted true, and never re-signs", async () => {
    const jobs = new MemoryJobStore();
    const key = keyFor();
    await jobs.claim(key);
    const vote = { schema: "fleet.vote.v1" as const, proposalId: PROPOSAL_ID.toString(), support: "FOR" as const, rationale: "r", assumptions: [], riskFlags: [] };
    await jobs.update(key, { state: "REQUEST_SIGNATURE", vote });

    const client = makeFakeClient({ hasVoted: true });
    const signer = makeFakeSigner();
    const nonces = makeFakeNonces();
    const { worker } = makeWorker({ jobs, client, signer, nonces });

    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(nonces.reconcile).toHaveBeenCalledWith(AGENT_ACCOUNT);
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
    expect(job.state).toBe("already_voted");
  });

  it("returns a terminal job unchanged without re-processing it", async () => {
    const jobs = new MemoryJobStore();
    const key = keyFor();
    await jobs.claim(key);
    await jobs.update(key, { state: "absent" });

    const signer = makeFakeSigner();
    const { worker } = makeWorker({ jobs, signer });

    const job = await worker.handleProposal(PROPOSAL_ID);

    expect(job.state).toBe("absent");
    expect(signer.castVoteWithReason).not.toHaveBeenCalled();
  });
});

describe("Worker: job persistence", () => {
  it("persists a job record reachable by JobStore.get after every run, keyed as the brief specifies", async () => {
    const { worker, jobs } = makeWorker({ script: { [AGENT_ID]: "FOR" } });
    await worker.handleProposal(PROPOSAL_ID);

    const stored = await jobs.get(keyFor());
    expect(stored).not.toBeNull();
    expect(stored?.chainId).toBe(31337);
    expect(stored?.governor.toLowerCase()).toBe(GOVERNOR.toLowerCase());
    expect(stored?.proposalId).toBe(PROPOSAL_ID.toString());
    expect(stored?.agentAddress.toLowerCase()).toBe(AGENT_ACCOUNT.toLowerCase());
    expect(stored?.actionType).toBe("vote");
  });
});
