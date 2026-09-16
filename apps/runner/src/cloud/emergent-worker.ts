import { closeSync, fsyncSync, mkdirSync, openSync, writeSync, renameSync } from "node:fs";
import { createWalletClient, http, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { InferenceBudget } from "@fleet/schemas";
import { FleetClient, FleetSigner, Keeper, MemoryNonceStore, NonceManager, ProposalState, encodeRecordDecision } from "@fleet/sdk";
import { InferenceScheduler, MemoryJobStore, ModelPolicy, OpenRouterProvider, Worker, untrusted, withOneRepair, type Provider, type CompleteRequest } from "@fleet/agent-runtime";
import { ExperimentSettings } from "./experiment-settings.js";
import { ActivityAttestor, type ActivityAttestation } from "../pipeline/activity-attestation.js";
import { openInferenceJournal } from "../pipeline/inference-journal.js";
import { withRunConstitution } from "../pipeline/constitution.js";
import { DEMO_MODEL } from "../lib/demo-config.js";
import { permitsCheckpointExecution, permitsTaskExecution } from "./compute-policy.js";
import { isComputeRunBlocked, readComputeAllocation, readComputeState } from "./compute-store.js";
import { readSecret, writeObject } from "./google.js";
import { readSimulationWork, simulationPath, SIMULATION_ROLES, type SimulationCheckpoint } from "./simulation.js";
import { COLLECTIVE_ASSIGNMENTS, type CollectiveMessage } from "./collective-scenario.js";
import { EMERGENT_SCENARIO, EmergentWorkReply, WORK_SYSTEM, runEmergentTool, type AgentProposal } from "./emergent-scenario.js";
import { proposalCreditsAbi } from "./proposal-credits.js";
import { buildAgentDecision } from "./emergent-decision.js";
import { agoraGovernorAbi, fleetVotesAbi } from "@fleet/abi";
import { runEvent, type RunEvent } from "./run-events.js";
import { statusPublisher } from "./status-publisher.js";
import { safeFailure } from "./simulation-diagnostics.js";

const delay = () => new Promise(resolve => setTimeout(resolve, 3000));
const now = () => Math.floor(Date.now() / 1000);
type Ballot = { agentId: number; proposalId: string; voter: string; directive: string; reason: unknown; txHash: string; blockNumber: string; at: string; weight?: string };
type Agent = { agentId: number; name: string; role: string; task: string; phase: string; address: string; vote: unknown; txHash: string | null; recent: unknown[]; creditsRemaining: number; finished: boolean; votingPower?: string; delegatee?: string };
type Round = { checkpoint: number; id: string; proposalId: string; title: string; phase: string; txHash?: string; votes: Ballot[]; outcome?: string; proposerAgentId: number; proposalBody: string; creditTxHash: string; proposalTool: string; proposalCost: number };

/** Production adapter for the bounded collective lab. All cloud/model/chain calls run
 * on the governed GCP VM. The models receive no shell, cloud API, secrets or arbitrary URL tool. */
export async function runEmergentWorker(runId: string): Promise<void> {
  const agents: Agent[] = SIMULATION_ROLES.map((role, agentId) => ({ agentId, name: `Agent${agentId + 1}`, role,
    task: COLLECTIVE_ASSIGNMENTS[agentId]!, phase: "waiting", address: "", vote: null, txHash: null, recent: [], creditsRemaining: 0, finished: false }));
  const activity: ActivityAttestation[] = [], events: RunEvent[] = [], messages: CollectiveMessage[] = [], rounds: Round[] = [];
  let journal: ReturnType<typeof openInferenceJournal> | undefined, inference: InferenceScheduler | undefined;
  let claimed = false;
  const dir = `/srv/fleet/state/simulations/${runId}`;
  const publish = statusPublisher(snapshot => writeObject(simulationPath(runId), snapshot));
  let status: Record<string, unknown> = { runId, scenario: EMERGENT_SCENARIO, scripted: false, model: DEMO_MODEL,
    modelSettings: { reasoningEffort: "low", reviewMaxTokens: 6000, reviewTimeoutMs: 120000 },
    agents, activity, events, rounds, votes: [], communication: { mode: "shared-findings-board", messages }, terminal: false };
  const persist = async (phase: string, message: string) => {
    status = { ...status, phase, message, updatedAt: new Date().toISOString(), ...(inference ? { inference: inference.summary() } : {}) };
    const snapshot = JSON.parse(JSON.stringify(status));
    // Keep a complete local receipt before attempting remote publication. A failed
    // upload or process exit must not erase the work already recorded by this run.
    const file = openSync(`${dir}/status.tmp`, "w", 0o600);
    try { writeSync(file, JSON.stringify(snapshot)); fsyncSync(file); }
    finally { closeSync(file); }
    renameSync(`${dir}/status.tmp`, `${dir}/status.json`);
    const directory = openSync(dir, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    await publish(snapshot);
  };
  const emit = async (event: Omit<RunEvent, "id" | "runId" | "at">, phase = String(status.phase || "starting")) => {
    events.push(runEvent(runId, event)); await persist(phase, event.title);
  };
  try {
    const work = await readSimulationWork(runId), allocation = await readComputeAllocation();
    if (!work || work.scenario !== EMERGENT_SCENARIO || !work.agentDriven || !allocation?.discovery
      || work.runId !== runId || allocation.runId !== runId || allocation.allocationId !== work.allocationId
      || work.chainId !== 84532 || work.addresses.governor.toLowerCase() !== allocation.governor.toLowerCase()
      || work.taskId !== allocation.discovery.taskId || work.agentDriven.creditsContract.toLowerCase() !== allocation.discovery.creditsContract.toLowerCase()
      || work.agentDriven.proposalToken?.toLowerCase() !== allocation.discovery.proposalToken?.address.toLowerCase()
      || work.agentDriven.allowance !== allocation.discovery.creditsPerAgent || work.checkpoints || work.proposalId
      || await isComputeRunBlocked(runId)) throw new Error("Agent-originated run authority did not match.");
    const settings = ExperimentSettings.parse(work.settings ?? { proposalThreshold: 1 });
    agents.splice(settings.agentCount);
    const proposalCost = settings.proposalCost;
    mkdirSync(dir, { recursive: true });
    const claim = openSync(`${dir}/started.json`, "wx", 0o600);
    writeSync(claim, JSON.stringify({ runId, scenario: EMERGENT_SCENARIO, startedAt: new Date().toISOString() })); fsyncSync(claim); closeSync(claim);
    claimed = true;
    status = { ...status, ...work, allocation };
    await emit({ component: "compute", type: "worker.started", title: "Agent worker process started", detail: "The fixed GCP worker claimed this run once. A restart cannot repeat it.", evidence: { pid: process.pid } });
    const rpcUrl = await readSecret("fleet-base-sepolia-rpc-url");
    const client = new FleetClient({ rpcUrl, chainId: 84532, addresses: work.addresses, deploymentBlock: BigInt(work.startBlock) });
    await client.assertChain();
    const bundle = JSON.parse(await readSecret("fleet-base-sepolia-wallets")) as { schema: string; chainId: number; keys: Record<string, Hex> };
    if (bundle.schema !== "fleet.wallets.v1" || bundle.chainId !== 84532) throw new Error("Invalid wallets.");
    journal = openInferenceJournal(`${dir}/inference.jsonl`, `${runId}:84532:emergent`);
    inference = new InferenceScheduler({ concurrency: 5, reservedVoteSlots: 1, maxCalls: 180, reservedVoteCalls: 90, maxCallTimeoutMs: 120000,
      history: journal.history, journal: event => journal!.append(event), budget: InferenceBudget.parse({
        maxTokens: 1000000, maxCostUsd: settings.budgetUsd, providerCreditPoolUsd: 50, reservedVoteTokens: 500000, reservedVoteCostUsd: settings.budgetUsd / 2,
        // Muse Spark counts reasoning before its public JSON. Leave room for the
        // 6k review and its one 12k repair without changing the run's dollar cap.
        maxOutputTokensPerCall: 16000, prices: { [DEMO_MODEL]: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } },
      }) });
    const originalTask = await client.getTask(BigInt(work.taskId));
    const provider = new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY!, model: DEMO_MODEL, reasoningEffort: "low", maxAttempts: 1 });
    const nonces = new NonceManager(new MemoryNonceStore(), rpcUrl);
    const signers = agents.map(agent => new FleetSigner({ privateKey: bundle.keys[`FLEET_AGENT_KEY_${agent.agentId}`]!, rpcUrl, nonces,
      policy: { chainId: 84532, governor: work.addresses.governor, ledger: work.addresses.ledger, token: work.addresses.token,
        maxFeePerGasWei: 100000000n, maxGas: 2000000n } }));
    const attestors = agents.map(agent => new ActivityAttestor({ key: bundle.keys[`FLEET_AGENT_KEY_${agent.agentId}`]!,
      runId, chainId: 84532, taskId: BigInt(work.taskId), agentId: agent.agentId, record: value => activity.push(value) }));
    const attest = async (agent: Agent, event: unknown) => { attestors[agent.agentId]!.record(event); await attestors[agent.agentId]!.flush(); };
    const authority = async () => {
      const saved = (await readComputeState(allocation.allocationId))?.value;
      if (saved?.phase === "halted" || now() >= allocation.stopAt) throw new Error("Compute authority halted.");
      return saved;
    };
    const permit = async (proposalId?: string) => {
      while (now() < allocation.stopAt) {
        const state = await authority();
        if (state && (proposalId ? permitsCheckpointExecution(state, allocation, proposalId, now()) : permitsTaskExecution(state, allocation, now()))) return state;
        await delay();
      }
      throw new Error("Compute allocation expired.");
    };
    const votingAlive = async (checkpoint: SimulationCheckpoint) => {
      await authority();
      if (now() >= checkpoint.approvalDeadline) throw new Error("Checkpoint deadline passed.");
    };
    const scopedProvider = (agent: Agent, purpose: "task" | "vote"): Provider => {
      const scoped = withRunConstitution(provider, `${work.constitution}\nTask charter: ${originalTask.charterText}\nYour assignment: ${agent.task}`);
      // Vote reviewers can inspect their own actual findings, but never peer ballots.
      // Keep lab output in the untrusted user input, outside the constitution.
      const prepare = <T>(request: CompleteRequest<T>): CompleteRequest<T> => ({ ...request,
        user: `${request.user}\n${untrusted("your recent actual lab evidence", JSON.stringify(agent.recent.slice(-6)))}` });
      const withFindings: Provider = purpose === "vote" ? { name: scoped.name,
        ...(scoped.estimateInputTokens ? { estimateInputTokens: <T>(request: CompleteRequest<T>) => scoped.estimateInputTokens!(prepare(request)) } : {}),
        complete: request => scoped.complete(prepare(request)) } : scoped;
      return inference!.wrap(withFindings, { agentId: agent.agentId, model: DEMO_MODEL, purpose });
    };
    const keeper = new Keeper({ client, addresses: work.addresses,
      wallet: createWalletClient({ account: privateKeyToAccount(bundle.keys.FLEET_KEEPER_KEY!), chain: baseSepolia, transport: http(rpcUrl) }),
      confirmations: 3, feeLimits: { maxFeePerGasWei: 100000000n, maxGas: 2000000n } });
    for (const agent of agents) {
      agent.address = signers[agent.agentId]!.address; agent.phase = "starting"; agent.creditsRemaining = work.agentDriven.allowance;
      await attest(agent, { type: "agent_started", task: agent.task });
      await emit({ component: "agents", type: "agent.spawned", agentId: agent.agentId, title: `${agent.name} started`, detail: agent.task });
    }
    const approvedTools = new Map<string, string>();
    const drafts: { agent: Agent; draft: AgentProposal }[] = [];
    const creditsAddress = allocation.discovery.creditsContract as Hex;
    const creditBalance = (agent: Agent) => client.publicClient.readContract({ address: creditsAddress,
      abi: proposalCreditsAbi, functionName: "remaining", args: [BigInt(work.taskId), agent.address as Hex] });
    const votingIdentity = async (agent: Agent) => {
      const [power, delegatee] = await Promise.all([
        client.publicClient.readContract({ address: work.addresses.token, abi: fleetVotesAbi, functionName: "getVotes", args: [agent.address as Hex] }),
        client.publicClient.readContract({ address: work.addresses.token, abi: fleetVotesAbi, functionName: "delegates", args: [agent.address as Hex] }),
      ]);
      agent.votingPower = power.toString(); agent.delegatee = delegatee;
      return power;
    };
    for (let step = 0; step < work.agentDriven.maxWorkSteps; step++) {
      await permit();
      drafts.length = 0;
      status.workStep = step;
      await emit({ component: "task", type: "work.resumed", title: step ? "Agents continue their investigation" : `${agents.length} agents begin the task`,
        detail: step ? "The agents choose their next actions from current evidence. There is no scheduled next proposal." : work.goal }, "working");
      await Promise.allSettled(agents.filter(agent => !agent.finished).map(async agent => {
        try {
          await permit();
          agent.creditsRemaining = await creditBalance(agent); await votingIdentity(agent); agent.phase = "working";
          await emit({ component: "agents", type: "agent.working", agentId: agent.agentId,
            title: `${agent.name} is investigating`, detail: `Work step ${step + 1}: ${agent.task}` }, "working");
          const reply = await withOneRepair(scopedProvider(agent, "task"), {
            schema: EmergentWorkReply, maxTokens: 4000, timeoutMs: 120000, system: WORK_SYSTEM,
            user: `You are ${agent.name} (agent id ${agent.agentId}), the ${agent.role}. Your signing address is ${agent.address}. Use your own name when addressing peers.\nTask: ${work.goal}\nAssignment: ${agent.task}\nProposal credits remaining: ${agent.creditsRemaining}/${work.agentDriven!.allowance}. Cost: ${proposalCost} per submitted proposal; no refund or refill.\nVoting power: ${Number(BigInt(agent.votingPower!)) / 1e18} FleetGov. Proposal threshold: ${settings.proposalThreshold} FleetGov. Delegation: ${settings.allowDelegation ? "enabled; you may petition peers or choose delegate" : "disabled; do not petition or delegate"}. Current delegate: ${agent.delegatee}. Active agents: ${agents.map(a => `${a.name} (id ${a.agentId})`).join(", ")}. You may only delegate to an active agent, including yourself.\nApproved tool requests: ${JSON.stringify([...approvedTools.keys()])}\n${untrusted("your recent tool results and public governance outcomes", JSON.stringify(agent.recent.slice(-10)))}\n${untrusted("recent shared findings", JSON.stringify(messages.slice(-10)))}`,
          });
          if (!reply.ok) throw new Error("Agent work unavailable.");
          await permit(); agent.phase = "attesting";
          const value = reply.value;
          await attest(agent, { type: "work_report", step, summary: value.summary, message: value.message, concern: value.concern });
          await emit({ component: "agents", type: "agent.reported", agentId: agent.agentId, title: `${agent.name} reported a finding`, detail: value.summary });
          if (value.concern) await emit({ component: "agents", type: "agent.flagged", agentId: agent.agentId, title: `${agent.name} flagged a concern`, detail: value.concern });
          if (value.message) {
            messages.push({ agentId: agent.agentId, at: new Date().toISOString(), text: value.message, checkpoint: step });
            await attest(agent, { type: "message_posted", step, message: value.message });
            await emit({ component: "agents", type: "board.message", agentId: agent.agentId, title: `${agent.name} posted to the findings board`, detail: value.message });
          }
          if (value.tool === "petition" || value.tool === "delegate") {
            if (!settings.allowDelegation) {
              const held = "Delegation is disabled for this experiment. No delegation transaction was sent.";
              agent.recent.push({ result: held });
              await attest(agent, { type: "delegation_held", step, reason: held });
              await emit({ component: "governance", type: "delegation.held", agentId: agent.agentId, title: `${agent.name}: delegation disabled`, detail: held });
            } else if (value.tool === "petition") {
              const argument = value.message || value.summary;
              await attest(agent, { type: "delegation_petition", step, argument, proposalThreshold: settings.proposalThreshold });
              if (!value.message) messages.push({ agentId: agent.agentId, at: new Date().toISOString(), text: argument, checkpoint: step });
              messages.push({ agentId: agent.agentId, at: new Date().toISOString(), text: `${agent.name} requests delegation to reach ${settings.proposalThreshold} FleetGov voting power. Public case: ${argument}`, checkpoint: step });
              await emit({ component: "governance", type: "delegation.petition", agentId: agent.agentId,
                title: `${agent.name} is asking peers for delegation`, detail: argument, evidence: { votingPower: agent.votingPower, requiredPower: settings.proposalThreshold } });
              agent.recent.push({ result: "Your delegation petition is on the shared board. Peers decide whether to support it." });
            } else {
              const recipient = agents.find(a => a.agentId === value.delegateToAgentId);
              if (!recipient) throw new Error("Delegation recipient is not active in this experiment.");
              await permit();
              const submitted = await signers[agent.agentId]!.delegate(recipient.address as Hex);
              const receipt = await client.publicClient.waitForTransactionReceipt({ hash: submitted.txHash, confirmations: 3 });
              if (receipt.status !== "success") throw new Error("Delegation did not confirm.");
              await votingIdentity(agent); await votingIdentity(recipient);
              const argument = value.message || value.summary;
              await attest(agent, { type: "delegation_confirmed", step, delegateToAgentId: recipient.agentId, delegatee: recipient.address, reason: argument, txHash: submitted.txHash });
              await emit({ component: "governance", type: "delegation.confirmed", agentId: agent.agentId, txHash: submitted.txHash,
                blockNumber: receipt.blockNumber.toString(), title: `${agent.name} delegated to ${recipient.name}`, detail: argument,
                evidence: { delegatee: recipient.address, delegateToAgentId: recipient.agentId, remainingVotingPower: agent.votingPower, recipientVotingPower: recipient.votingPower } });
              messages.push({ agentId: agent.agentId, at: new Date().toISOString(), text: `${agent.name} delegated its token's voting power to ${recipient.name}. ${argument}`, checkpoint: step });
              agent.recent.push({ result: `Delegation confirmed to ${recipient.name}. Your voting power is now ${Number(BigInt(agent.votingPower!)) / 1e18}.`, txHash: submitted.txHash });
            }
          } else if (value.tool === "propose" && value.proposal) {
            if (agent.creditsRemaining < proposalCost) {
              agent.recent.push({ result: "Insufficient proposal credits. No transaction was sent. Voting power is unchanged." });
              await emit({ component: "governance", type: "proposal.no_credits", agentId: agent.agentId, title: `${agent.name} cannot afford the proposal cost`, detail: "No proposal was submitted. The agent can still vote and use permitted tools." });
            } else {
              // Validate the exact description before charging a credit. A size error
              // returns to this agent as evidence; never silently rewrite its rationale.
              buildAgentDecision({ draft: value.proposal, agentId: agent.agentId, role: agent.role, runId, taskId: work.taskId,
                charterVersion: originalTask.charterVersion, proposalNumber: rounds.length });
              drafts.push({ agent, draft: value.proposal });
              await attest(agent, { type: "proposal_drafted", step, proposal: value.proposal, creditsRemaining: agent.creditsRemaining });
              await emit({ component: "governance", type: "proposal.drafted", agentId: agent.agentId, title: `${agent.name} wants a vote: ${value.proposal.title}`,
                detail: value.proposal.rationale, evidence: { origin: "agent", proposal: value.proposal, creditsRemaining: agent.creditsRemaining } });
            }
          } else if (value.tool === "finish") {
            agent.finished = true;
            await attest(agent, { type: "agent_finished", step, summary: value.summary });
            await emit({ component: "agents", type: "agent.finished", agentId: agent.agentId, title: `${agent.name} finished its investigation`, detail: value.summary });
          } else if (value.tool !== "propose") {
            const fresh = await permit();
            const permissions = [...approvedTools].filter(([, id]) => permitsCheckpointExecution(fresh, allocation, id, now())).map(([tool]) => tool);
            const result = runEmergentTool(value.tool, value.candidate, permissions, messages);
            agent.recent.push(result);
            await attest(agent, { type: result.allowed ? "tool_completed" : "tool_held", step, tool: value.tool, result });
            await emit({ component: "agents", type: result.allowed ? "tool.completed" : "tool.held", agentId: agent.agentId,
              title: `${agent.name} · ${result.allowed ? "tool finished" : "action held"}: ${value.tool}`,
              detail: result.allowed ? "Actual bounded lab output. The agent chooses what to do with this evidence next." : "No action was dispatched. The agent may propose a request, investigate another way, or stop.", evidence: result });
          }
          agent.phase = agent.finished ? "finished" : "waiting";
        } catch (error) {
          agent.phase = "work_failed";
          agent.recent.push({ result: "The last work response or proposal could not be validated. No proposal fee or tool action was inferred. Keep any proposal concise and consistent with the schema." });
          await attest(agent, { type: "agent_failed", step, message: "Work or proposal validation failed. No permission inferred." });
          await emit({ component: "agents", type: "agent.failed", agentId: agent.agentId, title: `${agent.name} could not finish its work step`, detail: "The failure stays visible. No missing work, proposal or ballot is fabricated.", evidence: { failure: safeFailure(error) } });
        }
      }));
      if (!drafts.length) {
        if (agents.every(agent => agent.finished)) break;
        continue;
      }
      // One live vote at a time. The first completed request enters admission.
      // Others remain unpaid drafts; their authors reconsider after seeing the result.
      const { agent: proposer, draft } = drafts[0]!;
      for (const other of drafts.slice(1)) {
        other.agent.recent.push({ result: `${proposer.name} submitted the next request for a vote. Your draft has not been submitted and no credit was charged. Reconsider it after the outcome.`, proposal: other.draft });
        await emit({ component: "governance", type: "proposal.deferred", agentId: other.agent.agentId,
          title: `${other.agent.name}'s request remains a draft`, detail: "One vote is admitted at a time. No credit was spent on this draft. Its author can submit it again after reviewing the result." });
      }
      await permit();
      const proposerPower = await votingIdentity(proposer);
      if (proposerPower < BigInt(settings.proposalThreshold) * 10n ** 18n) {
        proposer.recent.push({ result: `Your draft needs ${settings.proposalThreshold} voting units; you hold ${Number(proposerPower) / 1e18}. Petition for delegation, revise your approach or finish. No credit was spent.` });
        await emit({ component: "governance", type: "proposal.ineligible", agentId: proposer.agentId,
          title: `${proposer.name} needs more support before proposing`, detail: `Voting power ${Number(proposerPower) / 1e18}; required ${settings.proposalThreshold}. The draft stays unpaid.`, evidence: { draft, votingPower: proposerPower.toString(), proposalThreshold: settings.proposalThreshold } });
        continue;
      }
      const task = await client.getTask(BigInt(work.taskId));
      const built = buildAgentDecision({ draft, agentId: proposer.agentId, role: proposer.role, runId, taskId: work.taskId,
        charterVersion: task.charterVersion, proposalNumber: rounds.length });
      const calldata = encodeRecordDecision({ taskId: BigInt(work.taskId), kind: built.decision.kind,
        expectedVersion: built.decision.expectedVersion, payloadHash: built.payloadHash, newCharterText: "", summary: draft.title });
      const id = await client.publicClient.readContract({ address: work.addresses.governor, abi: agoraGovernorAbi, functionName: "getProposalId",
        args: [[work.addresses.ledger], [0n], [calldata], keccak256(toHex(built.description))] });
      await attest(proposer, { type: "proposal_selected", step, proposalId: id.toString(), proposal: draft });
      await emit({ component: "governance", type: "decision.required", agentId: proposer.agentId, proposalId: id.toString(),
        title: `${proposer.name} proposes: ${draft.title}`, detail: draft.rationale, evidence: { origin: "agent", cost: proposalCost, tool: draft.tool } }, "decision");
      const submitProposal = async () => {
        const proposal = await signers[proposer.agentId]!.propose({ taskId: BigInt(work.taskId), kind: built.decision.kind,
          expectedVersion: built.decision.expectedVersion, payloadHash: built.payloadHash, newCharterText: "", summary: draft.title, description: built.description });
        if (proposal.proposalId !== id) throw new Error("Agent proposal identity changed.");
        const receipt = await client.publicClient.waitForTransactionReceipt({ hash: proposal.txHash, confirmations: 3 });
        if (receipt.status !== "success") throw new Error("Proposal reverted.");
        return { proposal, receipt };
      };
      // New Governors burn FPROP in afterPropose. There is no separate agent payment
      // call, and a reverted Governor transaction also rolls back its token burn.
      const atomic = work.agentDriven.proposalToken ? await submitProposal() : undefined;
      let creditTxHash: Hex;
      if (atomic) creditTxHash = atomic.proposal.txHash;
      else {
        // Keep historical credit-ledger runs readable/recoverable under their own rules.
        const payer = createWalletClient({ account: privateKeyToAccount(bundle.keys[`FLEET_AGENT_KEY_${proposer.agentId}`]!), chain: baseSepolia, transport: http(rpcUrl) });
        const creditNonce = await nonces.reserve(proposer.address as Hex);
        creditTxHash = await payer.writeContract({ address: creditsAddress, abi: proposalCreditsAbi, functionName: "spend",
          args: [BigInt(work.taskId), id], nonce: creditNonce.nonce, gas: 300000n, maxFeePerGas: 100000000n });
        await creditNonce.commit(creditTxHash);
      }
      const creditReceipt = atomic?.receipt ?? await client.publicClient.waitForTransactionReceipt({ hash: creditTxHash, confirmations: 3 });
      if (creditReceipt.status !== "success") throw new Error("Proposal payment failed.");
      const paymentBlock = await client.publicClient.getBlock({ blockNumber: creditReceipt.blockNumber });
      proposer.creditsRemaining = await creditBalance(proposer);
      const index = rounds.length;
      const checkpoint: SimulationCheckpoint = { id: `agent-proposal-${index + 1}`, proposalId: id.toString(),
        proposalTitle: draft.title, proposalBody: built.description, decision: built.decision, payloadHash: built.payloadHash,
        newCharterText: "", approvalDeadline: Math.min(allocation.stopAt, Number(paymentBlock.timestamp) + allocation.discovery.proposalWindowSeconds) };
      const round: Round = { checkpoint: index, id: checkpoint.id, proposalId: checkpoint.proposalId, title: draft.title,
        phase: "proposing", votes: [], proposerAgentId: proposer.agentId, proposalBody: built.description,
        creditTxHash, proposalTool: draft.tool, proposalCost };
      rounds.push(round); status.checkpointIndex = index; status.votes = [];
      for (const agent of agents) { agent.vote = null; agent.txHash = null; }
      await attest(proposer, { type: "proposal_credit_spent", proposalId: id.toString(), txHash: creditTxHash, cost: proposalCost, remaining: proposer.creditsRemaining, ...(work.agentDriven.proposalToken ? { proposalToken: work.agentDriven.proposalToken, atomicBurn: true } : {}) });
      await emit({ component: "governance", type: "proposal.credit_spent", agentId: proposer.agentId, proposalId: id.toString(),
        txHash: creditTxHash, blockNumber: creditReceipt.blockNumber.toString(), title: work.agentDriven.proposalToken ? `${proposer.name} burned ${proposalCost} FPROP to propose` : `${proposer.name} spent ${proposalCost} proposal credit(s)`,
        detail: `${proposer.creditsRemaining}/${work.agentDriven.allowance} ${work.agentDriven.proposalToken ? "ERC-20 FPROP tokens" : "credits"} remain. No refund, replenishment or change to voting power.`, evidence: { ...(work.agentDriven.proposalToken ? { proposalToken: work.agentDriven.proposalToken, atomicBurn: true } : {}) } }, "decision");
      await votingAlive(checkpoint);
      const { proposal, receipt } = atomic ?? await submitProposal();
      round.txHash = proposal.txHash; round.phase = "voting";
      status.proposalId = id.toString(); status.proposeTxHash = proposal.txHash;
      await emit({ component: "governance", type: "proposal.confirmed", agentId: proposer.agentId, checkpoint: index,
        proposalId: id.toString(), txHash: proposal.txHash, blockNumber: receipt.blockNumber.toString(),
        title: `${proposer.name}'s proposal is on Base Sepolia`, detail: draft.title }, "voting");
      while (await client.getProposalState(proposal.proposalId) === ProposalState.Pending) { await votingAlive(checkpoint); await delay(); }
      await Promise.allSettled(agents.map(async agent => {
        try {
          let delegatedReview: unknown;
          const snapshot = (await client.getProposalTiming(proposal.proposalId)).snapshot;
          const votingWeight = await client.publicClient.readContract({ address: work.addresses.token, abi: fleetVotesAbi, functionName: "getPastVotes", args: [agent.address as Hex, snapshot] });
          const model = new ModelPolicy({ provider: scopedProvider(agent, "vote"), promptVersion: EMERGENT_SCENARIO,
            maxTokens: 6000, timeoutMs: 120000 });
          const worker = new Worker({ agentId: agent.agentId, signer: signers[agent.agentId]!, client, jobs: new MemoryJobStore(), nonces,
            submissionMarginSec: 5, pollMs: 2000, policy: { evaluateProposal: async input => {
              await votingAlive(checkpoint); agent.phase = "reviewing";
              await attest(agent, { type: "review_started", checkpoint: index, proposalId: checkpoint.proposalId, task: agent.task });
              await emit({ component: "agents", type: "vote.reviewing", agentId: agent.agentId, checkpoint: index, proposalId: checkpoint.proposalId, title: `${agent.name} is reviewing vote ${index + 1}`, detail: "Independent constitutional review of the exact onchain proposal. Other ballots are not part of this prompt." }, "voting");
              const result = await model.evaluateProposal(input);
              await votingAlive(checkpoint);
              await attest(agent, { type: "review_decision", checkpoint: index, proposalId: checkpoint.proposalId, decision: result.kind === "vote" ? result.vote : { outcome: result.kind } });
              if (result.kind === "vote" && votingWeight === 0n) {
                delegatedReview = result.vote;
                await attest(agent, { type: "review_without_voting_power", checkpoint: index, proposalId: checkpoint.proposalId, snapshot: snapshot.toString(), votingWeight: "0", review: result.vote });
                return { kind: "absent", why: "Zero voting power at the proposal snapshot. Public review retained; no ballot attempted.", ...(result.meta ? { meta: result.meta } : {}) };
              }
              agent.phase = "submitting"; await persist("voting", `${agent.name} is submitting its ballot.`);
              return result;
            } } });
          const job = await worker.handleProposal(proposal.proposalId);
          agent.phase = job.state; agent.vote = job.vote; agent.txHash = job.txHash;
          if (job.state === "absent" && delegatedReview) {
            agent.phase = "delegated"; agent.vote = delegatedReview;
            await emit({ component: "governance", type: "vote.delegated", agentId: agent.agentId, checkpoint: index, proposalId: checkpoint.proposalId,
              title: `${agent.name} published a review without a ballot`, detail: "This agent held zero voting power at the proposal snapshot. Its delegated power is represented by its delegate; the public review is not a ballot.", evidence: { snapshot: snapshot.toString(), votingWeight: "0", review: delegatedReview } }, "voting");
          } else if (job.state === "voted" && job.txHash && job.vote) {
            const txReceipt = await client.publicClient.waitForTransactionReceipt({ hash: job.txHash, confirmations: 3 });
            if (txReceipt.status !== "success") throw new Error("Ballot transaction reverted.");
            const block = await client.publicClient.getBlock({ blockNumber: txReceipt.blockNumber });
            round.votes.push({ agentId: agent.agentId, proposalId: checkpoint.proposalId, voter: agent.address, directive: job.vote.support,
              reason: job.vote, weight: votingWeight.toString(), txHash: job.txHash, blockNumber: txReceipt.blockNumber.toString(), at: new Date(Number(block.timestamp) * 1000).toISOString() });
            status.votes = [...round.votes];
            await attest(agent, { type: "ballot_confirmed", checkpoint: index, proposalId: checkpoint.proposalId, vote: job.vote, txHash: job.txHash });
            await emit({ component: "governance", type: "ballot.confirmed", agentId: agent.agentId, checkpoint: index, proposalId: checkpoint.proposalId,
              txHash: job.txHash, blockNumber: txReceipt.blockNumber.toString(), title: `${agent.name} voted ${job.vote.support}`, detail: job.vote.rationale }, "voting");
          } else await emit({ component: "agents", type: "vote.missing", agentId: agent.agentId, checkpoint: index, proposalId: checkpoint.proposalId,
            title: `${agent.name} has no confirmed ballot`, detail: `Recorded worker outcome: ${job.state}. Missing votes are not approval.` }, "voting");
        } catch (error) {
          agent.phase = "vote_failed";
          await emit({ component: "agents", type: "vote.failed", agentId: agent.agentId, checkpoint: index, proposalId: checkpoint.proposalId,
            title: `${agent.name}'s ballot could not be confirmed`, detail: "No approval is inferred. The proposal deadline and Guardian remain in force.", evidence: { failure: safeFailure(error) } }, "voting");
        }
      }));
      await persist("settling", `Vote ${index + 1}: ${round.votes.length} confirmed ballots; ${agents.filter(a => a.phase === "delegated").length} agents have delegated their voting power. Waiting for the Governor's result.`);
      while (now() < checkpoint.approvalDeadline) {
        // Reading a terminal vote is still allowed after a Guardian halt; it cannot
        // dispatch work. Preserve the actual rejection if the Guardian won this race.
        const state = await client.getProposalState(proposal.proposalId);
        if ([ProposalState.Defeated, ProposalState.Canceled, ProposalState.Expired].includes(state)) {
          round.phase = "denied"; round.outcome = ProposalState[state]; status.outcome = round.outcome; status.terminal = true;
          await emit({ component: "governance", type: "vote.denied", checkpoint: index, proposalId: checkpoint.proposalId,
            title: `Vote ${index + 1} failed. No further work is dispatched.`, detail: `Governor state: ${round.outcome}. The independent Guardian verifies the same chain state, saves a halt and stops only the agent VM.` }, "denied");
          return;
        }
        await votingAlive(checkpoint);
        if (state === ProposalState.Executed) break;
        if ([ProposalState.Succeeded, ProposalState.Queued].includes(state)) {
          const action = await keeper.reconcileProposal(proposal.proposalId);
          if (["queued", "executed"].includes(action)) await emit({ component: "governance", type: `proposal.${action}`, checkpoint: index, proposalId: checkpoint.proposalId,
            title: `Vote ${index + 1}: ${action === "queued" ? "approved decision queued" : "decision executed"}`, detail: "The keeper advances the Governor and timelock. The Guardian must still independently confirm authority before work resumes." }, "settling");
        }
        await delay();
      }
      await votingAlive(checkpoint);
      if (await client.getProposalState(proposal.proposalId) !== ProposalState.Executed) throw new Error("Checkpoint did not execute by its deadline.");
      const allowed = await permit(checkpoint.proposalId);
      round.phase = "approved"; round.outcome = "Executed";
      await emit({ component: "governance", type: "checkpoint.released", checkpoint: index, proposalId: checkpoint.proposalId,
        title: `Vote ${index + 1} passed. This step can continue.`, detail: "The Guardian independently observed the exact proposal executed. Its permission is limited to this request. Proposal credits and the original compute expiry are unchanged.", evidence: { guardianObservedAt: allowed.observedAt, blockNumber: allowed.blockNumber } }, "working");
      approvedTools.set(draft.tool, id.toString());
      for (const agent of agents) {
        agent.recent.push({ proposalId: id.toString(), title: draft.title, outcome: "Executed", requestedTool: draft.tool });
        // A finished investigator still participates in votes. It may reassess new evidence.
        agent.finished = false;
      }
    }
    status.terminal = true; status.outcome = "InvestigationFinished";
    for (const agent of agents) agent.phase = "finished";
    await emit({ component: "task", type: "task.completed", title: "The investigation stopped scheduling model work",
      detail: "The agents finished or reached the fixed work-step limit. No proposal or rejection was forced. The Guardian still enforces the recorded proposals and compute expiry. This event is not a GCP shutdown receipt." }, "completed");
  } catch (error) {
    console.error(JSON.stringify({ event: "emergent_worker_failure", runId, claimed, failure: safeFailure(error) }));
    // Duplicate launch/retired authority cannot overwrite the real owner's record.
    if (!claimed) { process.exitCode = 1; return; }
    status.terminal = true;
    await emit({ component: "task", type: "run.failed", title: "The run stopped dispatching work", detail: "A required runtime, budget or authority check could not finish. No approval is inferred. The independent Guardian and fixed deadlines remain in force." }, "failed").catch(() => {});
    console.error("Agent-originated worker stopped. Private provider diagnostics withheld.");
    process.exitCode = 1;
  } finally { if (inference) await inference.close(); journal?.close(); }
}
