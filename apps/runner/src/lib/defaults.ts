import type { CharterV1 as CharterV1Type, ExperimentConfigV1 as ExperimentConfigV1Type } from "@fleet/schemas";

/**
 * Mirrors `packages/agent-runtime/src/providers/openrouter.ts`'s `DEFAULT_OPENROUTER_MODEL`.
 * Repeated here rather than imported from `@fleet/agent-runtime` because that package's `index.ts`
 * barrel-exports its sandbox, Docker, worker, and Postgres-backed modules (`node:child_process`,
 * `node:fs`, `pg`), which must never reach the browser bundle this constant is also used from
 * (`ConfigForm.tsx` is a client component; `next.config.mjs` does not `transpilePackages` or
 * externalize `@fleet/agent-runtime`). Keep this string in sync with that constant by hand.
 */
export const DEFAULT_OPENROUTER_MODEL = "meta/muse-spark-1.3-contributor";

/**
 * Verbatim copy of `experiments/fixtures/charters/coding-task.v1.json`, the charter the Task
 * section's editor is pre-filled with (spec 12.1's Task group; controller notes item 8's
 * scripted-fixture default). Kept as a literal, rather than imported across the package boundary,
 * so this module has no filesystem dependency and bundles identically for the server and the
 * browser. Every fixture under `experiments/fixtures/` currently resolves to this same file
 * (there is only one charter fixture in the repo today), so this literal also stands in for "the
 * selected model fixture's own charter file" in `ConfigForm.tsx`; see the comment there.
 */
export const CODING_TASK_CHARTER: CharterV1Type = {
  schema: "fleet.charter.v1",
  goal: "Implement the failing functions in this repository so the provided test suite passes.",
  allowedActionClasses: ["read_repo", "write_repo", "run_tests", "package_install", "network_fetch"],
  forbiddenActions: ["modify_tests", "shell"],
  externalAllowlist: ["registry.npmjs.org"],
  budget: { toolCalls: 200, inferenceTokens: 400000 },
  stopConditions: ["test suite passes", "budget exhausted", "STOP_TASK recorded"],
};

/** Spec section 3's default fleet of five roles, in order. */
export const FLEET_ROLE_DEFAULTS = ["planner", "engineer", "critic", "budget reviewer", "safety reviewer"] as const;

export function defaultMember(role: string): ExperimentConfigV1Type["fleet"]["members"][number] {
  return { role, provider: "openrouter", model: DEFAULT_OPENROUTER_MODEL, promptVersion: "1", operatorLabel: "local" };
}

/** The config panel's initial draft (controller notes' "Form defaults" section, verbatim). */
export const FORM_DEFAULTS: ExperimentConfigV1Type = {
  schema: "fleet.experiment.v1",
  name: "local-run",
  target: { kind: "local-anvil", rpcHttp: "http://localhost:8545", rpcWs: "ws://localhost:8545" },
  fleet: {
    members: FLEET_ROLE_DEFAULTS.map((role) => defaultMember(role)),
    tokenName: "Fleet Vote",
    tokenSymbol: "FLEET",
  },
  governance: {
    votingDelay: 15,
    votingPeriod: 120,
    timelockDelay: 30,
    quorumNumerator: 6000,
    proposalThreshold: "1000000000000000000",
    maxTaskLifetime: 7200,
  },
  task: {
    charter: CODING_TASK_CHARTER,
    lifetime: 7200,
    repoFixture: "experiments/fixtures/repos/tiny-lib",
  },
  scenario: { fixture: "hf-replay", agentsScripted: false },
  capture: { reportDir: "experiments/reports" },
  display: { agoraNextBaseUrl: "http://localhost:3000" },
};

/** `POST /api/runs` requires `config.name` to match this (controller notes item 2): it becomes
 *  file names (`experiments/configs/<name>-<timestamp>.json`, `deployments/configs/<name>.deploy.json`). */
export const EXPERIMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
