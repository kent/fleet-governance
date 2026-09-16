import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OperatorEmail } from "./operators.js";
import { ExperimentSettings, experimentDefaults } from "./experiment-settings.js";
import { experimentIndex, experimentRecord } from "./experiment-records.js";
import { cachedSimulationSnapshot } from "./simulation-view.js";
import { BatchId, BatchInput, validateBatch } from "./batch-authority.js";
import { createBatch, startBatch, getBatch, cancelBatch } from "./batches.js";
import { RunId, createExperimentDraft, runExperimentDraft } from "./experiment-drafts.js";
import { publicSnapshot } from "./site-access.js";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(publicSnapshot(value)) }] });
export function experimentMcpServer(operator: OperatorEmail) {
  const server = new McpServer({ name: "fleet-governance", version: "1.0.0" }, { instructions: "Create drafts, inspect their parameters and bounded cost, then explicitly run or start a batch. A start authorises real model spending and Base Sepolia transactions on GCP. Use stable UUID idempotency keys. Never infer success from an accepted request: inspect experiments and Guardian evidence. Agent counts are 3–5; the OpenRouter pool remains $50. Public reasons and attestations are evidence, not private chain of thought. Personal credentials are issued through the operator website." });
  server.registerTool("experiment_defaults", { description: "Get the supported pilot parameters and limits. No execution.", inputSchema: {}, annotations: readOnly }, async () => result({ defaults: experimentDefaults(), minAgents: 3, maxAgents: 5, maxRunBudgetUsd: 1, proposalEconomics: { standard: "ERC-20", symbol: "FPROP", fixedSupplyPerExperiment: true, atomicGovernorBurn: true, refundable: false, transferable: false, votingCostsProposalTokens: false }, maxBatchRuns: 25, defaultBatchBudgetUsd: 10, modelPoolUsd: 50 }));
  server.registerTool("list_experiments", { description: "List run records, links, costs and outcomes.", inputSchema: {}, annotations: readOnly }, async () => result(await experimentIndex()));
  server.registerTool("get_experiment", { description: "Inspect a run, agent activity, public rationales, votes and Guardian state.", inputSchema: { runId: RunId }, annotations: readOnly }, async ({ runId }) => result({ record: await experimentRecord(runId), snapshot: await cachedSimulationSnapshot(runId) }));
  server.registerTool("create_experiment", { description: "Save a draft without launching or spending. Supply run- followed by a UUID; reuse it on retries. The authenticated creator owns the draft.", inputSchema: { runId: RunId, settings: ExperimentSettings }, annotations: write }, async ({ runId, settings }) => result(await createExperimentDraft(runId, settings, operator)));
  server.registerTool("run_experiment", { description: "Authorise one saved draft to run in GCP. Real model spend up to its budget. GitHub Actions starts it on its next scheduled check and safely retires the allocation afterward.", inputSchema: { runId: RunId }, annotations: write }, async ({ runId }) => result(await runExperimentDraft(runId, operator)));
  server.registerTool("preview_batch", { description: "Validate an explicit array of parameter variants and calculate the sum of budget ceilings. No execution or storage. Expiry must be within 24 hours.", inputSchema: { plan: BatchInput }, annotations: readOnly }, async ({ plan }) => result(validateBatch(plan)));
  server.registerTool("create_batch", { description: "Save an immutable overnight parameter sweep without starting it. Use batch- followed by a UUID. Budgets are ceilings, not predicted spend; their sum cannot exceed maxBudgetUsd (default $10). The existing $50 provider cap remains unchanged.", inputSchema: { batchId: BatchId, plan: BatchInput }, annotations: write }, async ({ batchId, plan }) => result(await createBatch(batchId, plan, operator)));
  server.registerTool("start_batch", { description: "Authorise the saved finite run list and real model spending. Runs execute sequentially in GCP while the client is offline. Failed runs stay permanently blocked; each next run receives a fresh allocation after Guardian retirement. Only the creator can start.", inputSchema: { batchId: BatchId }, annotations: write }, async ({ batchId }) => result(await startBatch(batchId, operator)));
  server.registerTool("get_batch", { description: "Inspect batch progress and compare experiment parameters, proposals, ballots, delegations, costs and evidence links.", inputSchema: { batchId: BatchId }, annotations: readOnly }, async ({ batchId }) => result(await getBatch(batchId)));
  server.registerTool("cancel_batch", { description: "Cancel future starts. A run already reserved or running finishes under its original Guardian deadline, then is retired. This does not bypass the Guardian or restart compute.", inputSchema: { batchId: BatchId }, annotations: write }, async ({ batchId }) => result(await cancelBatch(batchId, operator)));
  return server;
}
