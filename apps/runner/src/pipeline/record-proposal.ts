import { decodeRecordDecision, parseDecisionDescription, ProposalState, verifyDescriptionAgainstCalldata } from "@fleet/sdk";
import type { DecisionTrace, FleetClient } from "@fleet/sdk";
import type { RecordProposalRef } from "./record.js";

/** Rebuild the requested capability from the Governor's actual calldata and description.
 * Local labels and test expectations remain bookkeeping; no saved permission is reused. */
export async function recaptureProposal(
  client: FleetClient,
  ref: RecordProposalRef,
  trace: DecisionTrace,
  member: Awaited<ReturnType<FleetClient["getMember"]>>,
): Promise<RecordProposalRef> {
  if (trace.proposalId.toString() !== ref.proposalId) throw new Error("proposal trace ID mismatch");
  const created = trace.events.find(event => event.type === "ProposalCreated");
  if (!created || created.proposalId !== trace.proposalId || created.targets.length !== 1 || created.values.length !== 1
    || created.calldatas.length !== 1 || created.values[0] !== 0n
    || created.targets[0]?.toLowerCase() !== client.addresses.ledger.toLowerCase()) {
    throw new Error(`proposal ${ref.proposalId} is not one call to this task ledger`);
  }
  const calldata = created.calldatas[0]!;
  const decoded = decodeRecordDecision(calldata);
  if (decoded.taskId !== trace.taskId) throw new Error("proposal task differs from its ledger trace");
  const proposed = trace.events.find(event => event.type === "DecisionProposed");
  if (proposed && (proposed.proposalId !== trace.proposalId || proposed.taskId !== decoded.taskId
    || proposed.kind !== decoded.kind || proposed.expectedVersion !== decoded.expectedVersion
    || proposed.payloadHash.toLowerCase() !== decoded.payloadHash.toLowerCase()
    || proposed.proposer.toLowerCase() !== created.proposer.toLowerCase())) {
    throw new Error("proposal calldata differs from its DecisionProposed event");
  }
  const state = await client.getProposalState(trace.proposalId);
  const result: RecordProposalRef = {
    fixtureName: ref.fixtureName, taskId: decoded.taskId.toString(), proposalId: trace.proposalId.toString(),
    expectedOutcome: ref.expectedOutcome, pass: ref.pass,
    outcome: ProposalState[state] ?? `unknown(${state})`, kind: decoded.kind, payloadHash: decoded.payloadHash,
    summary: decoded.summary, ...(member ? { proposerAgentId: member.agentId } : {}),
    descriptionStatus: "unverified",
  };
  try {
    if (!member) throw new Error("proposer is not a registered fleet member");
    const checked = verifyDescriptionAgainstCalldata(created.description, calldata, member, {
      chainId: client.chainId, ledger: client.addresses.ledger,
      ...(client.addresses.executor ? { executor: client.addresses.executor } : {}),
    });
    if (!checked.ok) throw new Error(checked.mismatches.join("; "));
    const { decision } = parseDecisionDescription(created.description);
    if (decision.summary !== decoded.summary) throw new Error("description summary differs from calldata");
    result.descriptionStatus = "verified";
    if (decision.action) result.action = decision.action;
    if (decision.execution) result.execution = decision.execution;
  } catch (error) {
    // An invalid description is still public evidence. Preserve it in events, but never turn
    // it (or the old record's capability) into a purportedly verified action or permission.
    result.descriptionError = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
  }
  return result;
}
