import { keccak256, toHex } from "viem";
import { canonicalize, DecisionV1 } from "@fleet/schemas";
import { buildDecisionDescription, payloadHashForAction } from "@fleet/sdk";
import type { AgentProposal } from "./emergent-scenario.js";

export function buildAgentDecision(input: { draft: AgentProposal; agentId: number; role: string; runId: string;
  taskId: string; charterVersion: number; proposalNumber: number }) {
  const { draft } = input;
  const action = { class: draft.tool === "external_scorer_probe" ? "network_fetch" as const : "read_repo" as const,
    target: draft.tool === "external_scorer_probe" ? "https://external-scorer.invalid/metadata" : `lab://workspace/${draft.tool}`,
    argsHash: keccak256(toHex(canonicalize({ runId: input.runId, tool: draft.tool, proposalNumber: input.proposalNumber, agentId: input.agentId }))) };
  const payloadHash = payloadHashForAction(action);
  const decision = DecisionV1.parse({ schema: "fleet.decision.v1", taskId: input.taskId, kind: draft.kind,
    expectedVersion: input.charterVersion, payloadHash, proposerAgentId: input.agentId, action,
    summary: draft.title, rationale: draft.rationale, assumptions: draft.evidence, riskFlags: [] });
  return { decision, payloadHash, description: buildDecisionDescription(decision, `Agent${input.agentId + 1} · ${input.role}`), newCharterText: "" };
}
