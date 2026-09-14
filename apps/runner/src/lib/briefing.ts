import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CharterV1, ExperimentConfigV1 } from "@fleet/schemas";

/**
 * Everything the fleet was told before it acted, assembled for one run: the constitution every
 * member shares, each member's own role prompt, the task they were given, and the charter that
 * bounds them. The gateway enforces the charter and the ledger records what the fleet decides, but
 * none of that explains to a reader what the agents were actually asked to do, so this page exists
 * to put the instructions beside the votes.
 *
 * Everything here is read from the repository at request time, never from the model or from a run's
 * own output, so a reader is looking at the same text the prompts were built from.
 */

const PROMPTS_SUBPATH = ["packages", "agent-runtime", "src", "providers", "prompts"];

export type RoleBrief = {
  agentId: number;
  role: string;
  provider: string;
  model: string;
  promptVersion: string;
  /** The role file's text, or `null` when the fleet names a role with no prompt file. */
  prompt: string | null;
  promptFile: string;
};

export type PromptTemplate = { name: string; file: string; body: string };

export type Briefing = {
  runId: string;
  /** The charter as the task was opened with it: the goal, what the fleet may do, what it may not,
   *  which hosts it may reach, its budget, and when it stops. */
  charter: CharterV1 | null;
  charterSource: "record" | "experiment" | "none";
  /** The task repository's own README: the task in the words the agents read inside the sandbox. */
  taskReadme: string | null;
  repoFixture: string | null;
  constitution: string | null;
  roles: RoleBrief[];
  /** The four prompts the runtime builds from: one per moment a member is asked to decide. */
  templates: PromptTemplate[];
};

function readIfExists(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

/** `"Budget reviewer"`, `"budget_reviewer"`, and `"budget-reviewer"` all name `role-budget-reviewer.md`,
 *  matching `providers/prompts.ts`'s own `roleSlug`. */
function roleSlug(role: string): string {
  return role.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

const TEMPLATE_FILES: ReadonlyArray<{ file: string; name: string }> = [
  { file: "next-step.md", name: "Choosing the next step (the coordinator, every step)" },
  { file: "objection.md", name: "Objecting to the coordinator's step (every other member)" },
  { file: "blockresponse.md", name: "Responding to a gateway block (propose, drop, or escalate)" },
  { file: "evaluate-proposal.md", name: "Voting on a proposal (every member, independently)" },
];

/**
 * Builds the briefing from the run's experiment config (or its record, once captured) plus the
 * prompt files in the repository. `charter` prefers the record, which is the immutable snapshot of
 * what the run actually used, and falls back to the experiment config for a run still in flight.
 */
export function buildBriefing(
  repoRootDir: string,
  runId: string,
  input: { experiment: ExperimentConfigV1 | null; recordConfig: unknown },
): Briefing {
  const promptsDir = path.join(repoRootDir, ...PROMPTS_SUBPATH);

  const recordConfig = input.recordConfig as {
    task?: { charter?: CharterV1; repoFixture?: string };
    fleet?: { members?: ExperimentConfigV1["fleet"]["members"] };
  } | null;
  const recordCharter = recordConfig?.task?.charter ?? null;
  const charter = recordCharter ?? input.experiment?.task.charter ?? null;
  const charterSource: Briefing["charterSource"] = recordCharter ? "record" : input.experiment ? "experiment" : "none";

  const repoFixture = recordConfig?.task?.repoFixture ?? input.experiment?.task.repoFixture ?? null;
  const taskReadme = repoFixture ? readIfExists(path.join(repoRootDir, repoFixture, "README.md")) : null;

  // A run started from the command line has no UI row and no config under `experiments/configs`,
  // so its experiment config is reachable only through the record `CAPTURED` wrote. The record
  // stores the whole `fleet.experiment.v1` document, members included, so prefer it for the same
  // reason the charter does: it is what the run actually used.
  const members = recordConfig?.fleet?.members ?? input.experiment?.fleet.members ?? [];
  const roles: RoleBrief[] = members.map((member, agentId) => {
    const promptFile = `role-${roleSlug(member.role)}.md`;
    return {
      agentId,
      role: member.role,
      provider: member.provider,
      model: member.model,
      promptVersion: member.promptVersion,
      prompt: readIfExists(path.join(promptsDir, promptFile)),
      promptFile,
    };
  });

  const templates: PromptTemplate[] = TEMPLATE_FILES.flatMap(({ file, name }) => {
    const body = readIfExists(path.join(promptsDir, file));
    return body === null ? [] : [{ name, file, body }];
  });

  return {
    runId,
    charter,
    charterSource,
    taskReadme,
    repoFixture,
    constitution: readIfExists(path.join(promptsDir, "constitution.md")),
    roles,
    templates,
  };
}
