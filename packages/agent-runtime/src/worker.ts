import { keccak256, toHex } from "viem";
import type { Address, Hex } from "viem";
import type { DecisionV1, VoteV1 } from "@fleet/schemas";
import {
  ProposalState,
  decodeRecordDecision,
  parseDecisionDescription,
  renderVoteReason,
  supportToUint8,
  verifyDescriptionAgainstCalldata,
} from "@fleet/sdk";
import type { FleetClient, FleetSigner, NonceManager } from "@fleet/sdk";
import type { AnchoredProposal, DecisionPolicy, PolicyOutput } from "./policy.js";
import type { JobKey, JobRecord, JobState, JobStore } from "./jobs.js";

export type WorkerConfig = {
  agentId: number;
  signer: FleetSigner;
  client: FleetClient;
  policy: DecisionPolicy;
  jobs: JobStore;
  /**
   * The same `NonceManager` the caller used to build `signer` (`FleetSigner` reserves and
   * commits nonces through its own private `NonceManager`, so this is a separate reference to
   * that same manager, not a second one). Not part of the brief's illustrative `WorkerConfig`
   * snippet; added because the controller notes require it directly: a job resumed mid
   * `REQUEST_SIGNATURE` (crashed after `FleetSigner.castVoteWithReason` may have reserved a
   * nonce internally, before this worker learned whether it sent) calls `NonceManager.reconcile`
   * before deciding whether to retry. There is no other way to reach that call: `FleetSigner`
   * does not expose its internal `NonceManager`, and this worker must never sign or send
   * around `FleetSigner` (spec 10.7).
   */
  nonces: NonceManager;
  submissionMarginSec: number;
  pollMs: number;
};

const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "voted",
  "absent",
  "worker_failed",
  "refused_for_on_mismatch",
  "missed",
  "already_voted",
]);

function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Best-effort extraction of `{ role }` from one agent's raw `FleetRegistry.agentManifest`
 *  string (JSON text, e.g. `{"role":"planner","provider":"scripted",...}`; spec's deploy
 *  manifests, `@fleet/schemas`'s `DeployConfigV1.agentManifests`). Never throws: a manifest that
 *  will not parse, or has no string `role`, reads back as `"unknown"` rather than failing the
 *  whole job over a cosmetic field. */
function parseRole(manifest: string): string {
  try {
    const parsed: unknown = JSON.parse(manifest);
    if (parsed && typeof parsed === "object" && "role" in parsed) {
      const role = (parsed as { role: unknown }).role;
      if (typeof role === "string") return role;
    }
  } catch {
    // fall through
  }
  return "unknown";
}

type SubmissionWindow = { ok: true } | { ok: false; reason: string };

type ConfirmedReceipt = { status: "success" | "reverted"; blockNumber: string; transactionHash: Hex };

/**
 * Turns one proposal into a vote for one agent: discover, read anchored state, evaluate through
 * a pluggable `DecisionPolicy`, validate, simulate, sign, submit, confirm, reconcile (spec 10.4),
 * persisting the `JobRecord` after every transition so a restart never double-votes.
 *
 * Every write this worker makes goes through `signer` (`FleetSigner`), never around it: the
 * signer alone decodes, policy-checks, simulates, and sends (spec 10.7). This worker's own job is
 * to decide *whether* to call it, and to make that decision safely across restarts.
 */
export class Worker {
  private readonly cfg: WorkerConfig;

  constructor(cfg: WorkerConfig) {
    this.cfg = cfg;
  }

  private buildKey(proposalId: bigint): JobKey {
    return {
      chainId: this.cfg.client.chainId,
      governor: this.cfg.client.addresses.governor,
      proposalId: proposalId.toString(),
      agentAddress: this.cfg.signer.address,
      actionType: "vote",
    };
  }

  private keyOf(record: JobKey): JobKey {
    return {
      chainId: record.chainId,
      governor: record.governor,
      proposalId: record.proposalId,
      agentAddress: record.agentAddress,
      actionType: record.actionType,
    };
  }

  private async persist(key: JobKey, patch: Partial<JobRecord>): Promise<JobRecord> {
    await this.cfg.jobs.update(key, patch);
    const updated = await this.cfg.jobs.get(key);
    if (!updated) {
      throw new Error(`Worker: job record for ${JSON.stringify(key)} vanished during persist`);
    }
    return updated;
  }

  /**
   * Drives the job for `proposalId` and this worker's agent through the state machine (spec
   * 10.4), from wherever its persisted `JobRecord` currently sits: a brand new key starts at
   * `DISCOVER`; an existing job resumes from its own persisted state (see `resume` rules below);
   * a job already in a terminal state is returned unchanged (idempotent: calling this again on a
   * finished job never re-processes it).
   */
  async handleProposal(proposalId: bigint): Promise<JobRecord> {
    const key = this.buildKey(proposalId);

    let job = await this.cfg.jobs.get(key);
    if (!job) {
      const claimed = await this.cfg.jobs.claim(key);
      job = claimed ?? (await this.cfg.jobs.get(key));
      if (!job) {
        throw new Error(`Worker.handleProposal: job for ${JSON.stringify(key)} vanished after claim`);
      }
    }

    if (isTerminal(job.state)) return job;

    // Restart resume, spec 10.8 as restated by the controller notes: a job found in SUBMIT with
    // a tx hash goes straight to CONFIRM (whatever signed and sent it already ran; this worker
    // just needs to learn the outcome).
    if (job.state === "SUBMIT" && job.txHash) {
      return this.confirmAndReconcile(job);
    }

    // A job found in REQUEST_SIGNATURE without a hash may have reserved a nonce (inside
    // FleetSigner's internal NonceManager) and even sent a transaction, without this process ever
    // learning about it before it crashed. Never re-run the pipeline blind from here.
    if (job.state === "REQUEST_SIGNATURE") {
      return this.resumeFromRequestSignature(job, proposalId);
    }

    // Every other state (DISCOVER, READ_ANCHORED_STATE, EVALUATE, VALIDATE, SIMULATE, or a fresh
    // claim) has done nothing irreversible yet: safe to (re-)run the whole pipeline, re-reading
    // chain state fresh rather than trusting anything stale.
    return this.runPipeline(key, proposalId);
  }

  private async readAnchoredState(proposalId: bigint): Promise<AnchoredProposal> {
    const client = this.cfg.client;
    const block = await client.publicClient.getBlock();
    const proposal = await client.getProposalCreated(proposalId);

    if (proposal.targets.length !== 1 || proposal.calldatas.length !== 1) {
      throw new Error(`proposal ${proposalId.toString()} does not carry exactly one recordDecision call`);
    }
    const calldata = proposal.calldatas[0]!;
    const decoded = decodeRecordDecision(calldata);
    const task = await client.getTask(decoded.taskId);
    if (!task.charter) {
      throw new Error(`task ${decoded.taskId.toString()}: charter text does not parse as fleet.charter.v1`);
    }

    const members = await client.listMembers();
    const selfMember = members.find((m) => sameAddress(m.account, this.cfg.signer.address));
    if (!selfMember) {
      throw new Error(`agent ${this.cfg.agentId} (${this.cfg.signer.address}) is not a registered fleet member`);
    }

    let decision: DecisionV1 | null = null;
    try {
      decision = parseDecisionDescription(proposal.description).decision;
    } catch {
      decision = null;
    }

    const proposerMember = members.find((m) => sameAddress(m.account, proposal.proposer));
    let verificationOk = false;
    if (decision && proposerMember) {
      const result = verifyDescriptionAgainstCalldata(proposal.description, calldata, { agentId: proposerMember.agentId });
      verificationOk = result.ok;
    }

    return {
      blockNumber: block.number,
      blockHash: block.hash,
      proposal,
      decision,
      task,
      charter: task.charter,
      member: { agentId: this.cfg.agentId, role: parseRole(selfMember.manifest), manifest: selfMember.manifest },
      verificationOk,
    };
  }

  private async checkSubmissionWindow(proposalId: bigint): Promise<SubmissionWindow> {
    const [state, timing, now] = await Promise.all([
      this.cfg.client.getProposalState(proposalId),
      this.cfg.client.getProposalTiming(proposalId),
      this.cfg.client.timestamp(),
    ]);
    if (state !== ProposalState.Active) {
      return { ok: false, reason: `proposal state is ${ProposalState[state]}, not Active` };
    }
    const remaining = timing.deadline - now;
    const margin = BigInt(this.cfg.submissionMarginSec);
    if (remaining < margin) {
      return {
        ok: false,
        reason: `${remaining.toString()}s remain before the voting deadline, under the ${margin.toString()}s submission margin`,
      };
    }
    return { ok: true };
  }

  private async runPipeline(key: JobKey, proposalId: bigint): Promise<JobRecord> {
    await this.persist(key, { state: "DISCOVER" });

    let anchored: AnchoredProposal;
    try {
      anchored = await this.readAnchoredState(proposalId);
    } catch (err) {
      return this.persist(key, { state: "worker_failed", lastError: errorMessage(err) });
    }
    await this.persist(key, {
      state: "READ_ANCHORED_STATE",
      inputBlockNumber: anchored.blockNumber,
      inputBlockHash: anchored.blockHash,
      manifestHash: keccak256(toHex(anchored.member.manifest)),
    });

    let output: PolicyOutput;
    try {
      output = await this.cfg.policy.evaluateProposal(anchored);
    } catch (err) {
      return this.persist(key, { state: "worker_failed", lastError: errorMessage(err) });
    }
    await this.persist(key, { state: "EVALUATE" });

    if (output.kind === "malformed") {
      // Spec 10.6: malformed output is a worker failure and a missing vote, never a For and
      // never a synthesized Abstain.
      return this.persist(key, { state: "worker_failed", lastError: `malformed policy output: ${output.raw}` });
    }
    if (output.kind === "absent") {
      return this.persist(key, { state: "absent", lastError: output.why });
    }

    const vote = output.vote;
    await this.persist(key, { state: "VALIDATE", vote });

    if (!anchored.verificationOk && vote.support === "FOR") {
      // Spec 8.2 / controller notes: verification failure refuses a For outright; downgrading to
      // Against or Abstain is not allowed either, so this is a refusal, not a substitution.
      return this.persist(key, {
        state: "refused_for_on_mismatch",
        lastError: "verifyDescriptionAgainstCalldata failed (or the decision/proposer could not be resolved); refusing to cast FOR",
      });
    }

    // "Before SUBMIT: re-read state and deadline" (spec 10.6, controller notes): this is that
    // fresh check. It is deliberately not persisted under a "SIMULATE" checkpoint (see
    // requestSignatureAndBeyond's comment for where SIMULATE actually belongs).
    const hasVotedNow = await this.cfg.client.hasVoted(proposalId, this.cfg.signer.address);
    if (hasVotedNow) {
      return this.persist(key, { state: "already_voted" });
    }

    const window = await this.checkSubmissionWindow(proposalId);
    if (!window.ok) {
      return this.persist(key, { state: "missed", lastError: window.reason });
    }

    return this.requestSignatureAndBeyond(key, proposalId, vote);
  }

  private async resumeFromRequestSignature(job: JobRecord, proposalId: bigint): Promise<JobRecord> {
    const key = this.keyOf(job);

    // A nonce may have been reserved (and possibly even sent) by FleetSigner's internal
    // NonceManager before this process learned the outcome; reconcile against the chain's own
    // pending nonce count before deciding anything.
    await this.cfg.nonces.reconcile(this.cfg.signer.address);

    const hasVotedNow = await this.cfg.client.hasVoted(proposalId, this.cfg.signer.address);
    if (hasVotedNow) {
      return this.persist(key, { state: "already_voted" });
    }

    if (!job.vote) {
      return this.persist(key, {
        state: "worker_failed",
        lastError: "resumed REQUEST_SIGNATURE with no persisted vote to retry",
      });
    }

    const window = await this.checkSubmissionWindow(proposalId);
    if (!window.ok) {
      return this.persist(key, { state: "missed", lastError: window.reason });
    }

    return this.requestSignatureAndBeyond(key, proposalId, job.vote);
  }

  /**
   * The one place that ever calls `signer.castVoteWithReason`: every entry into a signing
   * attempt, fresh or a resumed retry, increments and persists `attempts` here.
   *
   * `FleetSigner.castVoteWithReason` simulates the call first (`checkPolicy`, then
   * `publicClient.simulateContract`) before it reserves a nonce and sends (spec 10.7: "the signer
   * decodes and checks it again"), all inside that one call. The boundary between "simulated OK"
   * and "signing / reserving a nonce" is not observable from outside the signer, so this persists
   * `SIMULATE` and then `REQUEST_SIGNATURE` back to back, both immediately before the call,
   * rather than bracketing the simulate step on one side and the sign-and-send step on the
   * other. `REQUEST_SIGNATURE` is the state a restart resumes from
   * (`resumeFromRequestSignature`): it always carries the vote and the exact rendered reason this
   * call is about to submit, so a resumed retry re-sends byte-identical content.
   */
  private async requestSignatureAndBeyond(key: JobKey, proposalId: bigint, vote: VoteV1): Promise<JobRecord> {
    const current = await this.cfg.jobs.get(key);
    const attempts = (current?.attempts ?? 0) + 1;
    const reason = renderVoteReason(vote);

    await this.persist(key, { state: "SIMULATE" });
    await this.persist(key, { state: "REQUEST_SIGNATURE", publicReason: reason, vote, attempts });

    let txHash: Hex;
    try {
      const result = await this.cfg.signer.castVoteWithReason({
        proposalId,
        support: supportToUint8(vote.support),
        reason,
      });
      txHash = result.txHash;
    } catch (err) {
      return this.persist(key, { state: "worker_failed", lastError: errorMessage(err) });
    }

    const submitted = await this.persist(key, { state: "SUBMIT", txHash });
    return this.confirmAndReconcile(submitted);
  }

  private async confirmAndReconcile(job: JobRecord): Promise<JobRecord> {
    const key = this.keyOf(job);
    const txHash = job.txHash;
    if (!txHash) {
      return this.persist(key, { state: "worker_failed", lastError: "CONFIRM reached without a tx hash" });
    }

    await this.persist(key, { state: "CONFIRM" });

    let receipt: ConfirmedReceipt;
    try {
      const raw = await this.cfg.client.publicClient.waitForTransactionReceipt({ hash: txHash });
      receipt = { status: raw.status, blockNumber: raw.blockNumber.toString(), transactionHash: raw.transactionHash };
    } catch (err) {
      return this.persist(key, { state: "worker_failed", lastError: errorMessage(err) });
    }

    if (receipt.status !== "success") {
      return this.persist(key, {
        state: "worker_failed",
        receipt,
        lastError: `vote transaction reverted (${txHash})`,
      });
    }

    await this.persist(key, { state: "RECONCILE", receipt });
    return this.persist(key, { state: "voted" });
  }

  /**
   * One discovery-and-handle pass. This part's `Worker` has no proposal-discovery source of its
   * own (the controller notes: discovery is Part 4's task loop); callers that already know which
   * proposal ids need this agent's vote call `handleProposal` directly. `runOnce` is the hook
   * `start`'s poll loop calls, left a no-op here so a caller can still get a running poll loop
   * (for whatever future discovery gets wired into it) without depending on Part 4 yet.
   */
  async runOnce(): Promise<void> {
    // Intentionally empty; see the doc comment above.
  }

  /** Runs `runOnce` immediately, then every `pollMs`; returns a function that stops the loop. A
   *  `runOnce` failure is logged, never thrown out of the interval (an uncaught rejection inside
   *  `setInterval`'s callback would otherwise crash the process). */
  start(): () => void {
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        await this.runOnce();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Worker.runOnce failed:", err);
      }
    };

    void tick();
    const handle = setInterval(() => {
      void tick();
    }, this.cfg.pollMs);

    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }
}
