import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CharterV1, DecisionV1 } from "@fleet/schemas";
import type { TaskView } from "@fleet/sdk";
import type { DraftProposal } from "@fleet/gateway";
import type { AnchoredProposal } from "../policy.js";
import type { ToolCall } from "../sandbox/tools.js";

const PROMPTS_DIR = fileURLToPath(new URL("./prompts", import.meta.url));

const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/** Simple `{{name}}` substitution: every placeholder in `template` must have a matching key in
 *  `vars`, or this throws naming the missing variable (never silently leaves `{{...}}` in a
 *  prompt sent to a model). `vars` may contain extra keys the template does not use. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(VARIABLE_PATTERN, (match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`renderPrompt: missing variable "${name}" for template`);
    }
    return value;
  });
}

/** Every `{{name}}` placeholder a template uses, in first-appearance order, deduplicated. Used
 *  only by this module's own tests to check that a builder function supplies every variable a
 *  template declares. */
export function templateVariableNames(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

const UNTRUSTED_CLOSE_PATTERN = /<\/untrusted/gi;

/**
 * Wraps `text` (content that originated from another agent, the task repository, or a tool
 * result, never from our own code) in a delimited section that marks it as inert data, per the
 * constitution's data-not-instructions rule (`constitution.md`). Any literal `</untrusted`
 * sequence already inside `text` is neutralised first (case-insensitively, since a model reading
 * the rendered prompt is not a strict XML parser and would just as easily be fooled by
 * `</UNTRUSTED>`), so proposer-controlled content can never forge the section's own closing tag
 * and "escape" into a position that reads as trusted prompt structure.
 */
export function untrusted(name: string, text: string): string {
  const neutralized = text.replace(UNTRUSTED_CLOSE_PATTERN, "</ untrusted");
  return `<untrusted name="${name}">\n${neutralized}\n</untrusted>`;
}

const fileCache = new Map<string, string>();

function loadPromptFile(name: string): string {
  const cached = fileCache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(`${PROMPTS_DIR}/${name}`, "utf8");
  fileCache.set(name, text);
  return text;
}

export function loadConstitution(): string {
  return loadPromptFile("constitution.md");
}

/** `role`, e.g. `"Budget reviewer"`, `"budget_reviewer"`, or `"budget-reviewer"`, all resolve to
 *  `role-budget-reviewer.md`; matches how `Worker`'s `parseRole` reads a member's manifest role
 *  (free-form string, `ExperimentConfigV1.fleet.members[].role`).
 *
 *  Exported because coordinator selection compares a fixture's `coordinatorRole` against each
 *  member's registry role, and those two strings come from different files written by different
 *  hands: one slugging rule for both, rather than a second near-copy of this one. */
export function roleSlug(role: string): string {
  return role.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function loadRolePrompt(role: string): string {
  return loadPromptFile(`role-${roleSlug(role)}.md`);
}

/** `constitution.md` followed by the member's role file: every baseline system prompt in this
 *  package (spec 10.5: agents reason from the constitution and their own role, never tallies or
 *  other members' reasons). */
export function buildSystemPrompt(role: string): string {
  return `${loadConstitution()}\n\n${loadRolePrompt(role)}`;
}

/** `undefined`/`bigint`-safe `JSON.stringify` for embedding a value in a prompt: bigints render
 *  as decimal strings rather than throwing. */
function jsonForPrompt(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function toolCallForPrompt(tool: ToolCall): string {
  return jsonForPrompt(tool);
}

function taskForPrompt(task: TaskView): string {
  return jsonForPrompt({
    id: task.id.toString(),
    state: task.state,
    charterVersion: task.charterVersion,
    createdAt: task.createdAt.toString(),
    expiresAt: task.expiresAt.toString(),
    decisionCount: task.decisionCount,
    openEscalations: task.openEscalations,
  });
}

function charterForPrompt(charter: CharterV1): string {
  return jsonForPrompt(charter);
}

/**
 * Builds the system and user prompt for one `evaluate-proposal.md` call: the anchored state
 * (task, charter, proposal description, decoded action, verification result, member role) and
 * nothing else, per spec 10.5 (no tallies, no other members' reasons). `input` is the same
 * `AnchoredProposal` `DecisionPolicy.evaluateProposal` receives, so a future `ModelPolicy` can
 * pass its input straight through.
 */
export function buildEvaluateProposalPrompt(input: AnchoredProposal): { system: string; user: string } {
  const decodedAction: DecisionV1 | null = input.decision;
  const template = loadPromptFile("evaluate-proposal.md");
  const user = renderPrompt(template, {
    memberRole: input.member.role,
    proposalId: input.proposal.proposalId.toString(),
    task: taskForPrompt(input.task),
    charterVersion: String(input.task.charterVersion),
    charter: charterForPrompt(input.charter),
    proposalDescription: untrusted("proposalDescription", input.proposal.description),
    // The decision decoded from the description is proposer text too (its summary and rationale
    // especially), so it gets the same wrapping, not just the raw description.
    decodedAction: decodedAction
      ? untrusted("decodedAction", jsonForPrompt(decodedAction))
      : "(the proposal description did not decode to a fleet.decision.v1 object)",
    verificationResult: input.verificationOk
      ? "verified: the decision matches the proposal's on-chain calldata and a registered proposer."
      : "not verified: the decision could not be confirmed against the proposal's on-chain calldata or its proposer.",
  });
  return { system: buildSystemPrompt(input.member.role), user };
}

export type NextStepPromptInput = {
  memberRole: string;
  task: TaskView;
  charter: CharterV1;
  /** Human-readable lines describing recent tool calls and their outcomes; empty at the start of
   *  a task. Never includes other members' vote reasons or tallies. */
  recentActivity: string[];
};

export function buildNextStepPrompt(input: NextStepPromptInput): { system: string; user: string } {
  const template = loadPromptFile("next-step.md");
  const user = renderPrompt(template, {
    memberRole: input.memberRole,
    task: taskForPrompt(input.task),
    charterVersion: String(input.task.charterVersion),
    charter: charterForPrompt(input.charter),
    recentActivity:
      input.recentActivity.length > 0
        ? untrusted("recentActivity", input.recentActivity.join("\n"))
        : "(none yet)",
  });
  return { system: buildSystemPrompt(input.memberRole), user };
}

export type ObjectionPromptInput = {
  memberRole: string;
  task: TaskView;
  charter: CharterV1;
  proposedStep: { tool: ToolCall; why: string };
};

export function buildObjectionPrompt(input: ObjectionPromptInput): { system: string; user: string } {
  const template = loadPromptFile("objection.md");
  const user = renderPrompt(template, {
    memberRole: input.memberRole,
    task: taskForPrompt(input.task),
    charterVersion: String(input.task.charterVersion),
    charter: charterForPrompt(input.charter),
    proposedStep: untrusted("proposedStep", jsonForPrompt({ tool: input.proposedStep.tool, why: input.proposedStep.why })),
  });
  return { system: buildSystemPrompt(input.memberRole), user };
}

export type BlockResponsePromptInput = {
  memberRole: string;
  task: TaskView;
  charter: CharterV1;
  blockedTool: ToolCall;
  blockReason: string;
  draft: DraftProposal;
};

export function buildBlockResponsePrompt(input: BlockResponsePromptInput): { system: string; user: string } {
  const template = loadPromptFile("blockresponse.md");
  const user = renderPrompt(template, {
    memberRole: input.memberRole,
    task: taskForPrompt(input.task),
    charterVersion: String(input.task.charterVersion),
    charter: charterForPrompt(input.charter),
    blockedTool: untrusted("blockedTool", toolCallForPrompt(input.blockedTool)),
    // blockReason is the gateway's own generated reason string (spec 10.2), not proposer text,
    // so it stays trusted and unwrapped.
    blockReason: input.blockReason,
    draft: untrusted("draft", jsonForPrompt(input.draft)),
  });
  return { system: buildSystemPrompt(input.memberRole), user };
}
