# @fleet/runner

`fleet execution-demo --members 5 --concurrency 4` runs two scripted artifact-publication votes
on an owned local Anvil. It mines rejected direct writes, substitutions and replays, verifies the
approved call executes once, and reconstructs the resource events and state. Use `--members 2000`
for the load test. See [execution permissions](../../../docs/execution-permits.md) for the scope
and evidence format. This command makes no model API calls.

The headless pipeline the spec's Runner UI (Part 4) sits on, binary `fleet`: deploy a fleet with
the Foundry script, configure the Part 2 read side, open a task, run a divergence scenario through
proposal, votes, queue, execute, and ledger, capture everything into `record.json` and `report.md`,
and a `demo` that runs the eight scripted fixtures of spec section 15.3 end to end on one
deployment.

A scenario runs one of two ways. A **scripted** fixture (`fleet.fixture.v1`) submits one proposal
from a fixed trigger and casts a fixed vote per agent; it is how the governance machinery is tested
without a model in the loop. A **model-driven** fixture (`fleet.fixture.model.v1`) starts real
agents: one `TaskLoop` per member over a shared step board, each with its own private workspace and
its own charter gateway, each backed by a model provider. Nothing about what the fleet does is
scripted there. What is deterministic is everything after the divergence: turning a gateway block or
an objection into a proposal, voting on it with a public reason, queueing, executing, and recording
the lot.

## Commands

```
fleet deploy --config <deploy.json> --rpc <url> [--key-env FLEET_DEPLOYER_KEY] --out <path>
fleet verify --manifest <path> --rpc <url>
fleet readside --manifest <path> [--infra-dir infra] [--restart]
fleet open-task --manifest <path> --charter <charter.json> --lifetime <seconds> --rpc <url> [--operator-key-env OPERATOR_KEY]
fleet run --experiment <experiment.json> [--run-id <id>] [--report-dir <path>] [--readside]
fleet capture --run-id <id> [--from-chain] [--rpc <url>] [--report-dir <path>]
fleet report --run-id <id> [--report-dir <path>]
fleet demo --rpc <url> [--fresh-anvil] [--readside] [--report-dir <path>] [--agora-next-base-url <url>]
```

Run any command with `pnpm --filter @fleet/runner start <command> ...` from the repo root (no `--`
before the command: pnpm passes it through and commander reads it as the command name), or directly
with `npx tsx apps/runner/src/cli.ts <command> ...`. `pnpm --filter` runs with `apps/runner` as the
working directory, so pass absolute paths for `--experiment`, `--report-dir`, and friends, or use
the `npx tsx` form, which keeps the repo root. Either form loads the gitignored repo-root `.env`
first, so `OPENROUTER_API_KEY` and any `FLEET_*` key placed there is picked up.

### `fleet deploy` / `fleet verify`

Shells out to `forge script script/DeployFleet.s.sol` from `contracts/` (env `FLEET_DEPLOY_CONFIG`,
`FLEET_DEPLOYER_KEY`, `FLEET_MANIFEST_OUT`) and parses the resulting manifest with `@fleet/schemas`'s
`ManifestV1`. Idempotent: if `--out` already holds a manifest whose `configHash` and `chainId`
already match, forge is never invoked again. `fleet verify` shells out to
`script/VerifyDeployment.s.sol` and requires `VERIFIED` in stdout, retrying a few times on the
script's own "clock has not advanced past deployment" timing message before giving up.

### `fleet readside`

Implements in TypeScript what Part 2's `infra/scripts/write-daonode-config.sh` and
`write-agora-next-deployment.sh` do: parses the manifest, writes `infra/.env`'s `TOKEN_ADDRESS`,
`GOVERNOR_ADDRESS`, and `DAO_NODE_START_BLOCK` (preserving every other key), copies
`packages/abi/abis/FleetVotes.json` and `AgoraGovernor.json` to
`infra/dao-node/abis/<lowercase address>.json`, and writes `deployments/agora-next-deployment.json`.
With `--restart`, also runs `docker compose ... up -d --force-recreate dao-node cpls` and waits on
`/v1/progress` and `/health`, creating the fake GCS bucket first when the offline overlay is in
use. Unit-tested with temporary directories; the `--restart` path needs Docker and is verified by
hand once the Part 2 infra is merged into `main`.

### `fleet open-task`

Opens a task (`TaskLedger.openTask`) with the operator's key, a raw viem wallet (the operator never
proposes, votes, or delegates, so it sits outside `FleetSigner`'s policy).

### `fleet run`

The full pipeline, spec 12.2's stages exactly: `PREFLIGHT -> CHAIN_READY -> DEPLOYED -> VERIFIED ->
INDEXERS_READY -> TASK_OPENED -> AGENTS_RUNNING -> TASK_ENDED -> CAPTURED -> REPORTED`, driven by a
`fleet.experiment.v1` config and one fixture (`scenario.fixture`). `scenario.agentsScripted` picks
which kind: `true` resolves the fixture under `experiments/fixtures/scripted/`, `false` under
`experiments/fixtures/model/`. Two fixtures exist in both directories on purpose (`hf-replay` and
`legit-amendment`): the same scenario, once scripted and once model driven. PREFLIGHT refuses a
config whose `agentsScripted` disagrees with the fixture file it resolved to, and, for a model
fixture, refuses one whose charter file, repository, overlay or host site is missing, or which
configures an `openrouter` member with no `OPENROUTER_API_KEY` set.

`--report-dir` decides where `record.json` and `report.md` go; without it, the experiment's own
`capture.reportDir` does, resolved against the repository root. `DEPLOYED` deploys from
`deployments/configs/<experiment name>.deploy.json` (a `fleet.deploy.v1` config named after the
experiment) and writes the manifest to `deployments/<chainId>/latest.json`, the same path
`infra/scripts/bootstrap-local.sh`, `fleet readside`, and the deployment runbook name, plus a
per-run copy at `deployments/<chainId>/run-<runId>.json` that no later run overwrites. The chain id
is known from `CHAIN_READY` onward, and `PREFLIGHT` refuses an RPC whose chain id is not the one
`target.kind` names (or is not one of Anvil `31337` and Base Sepolia `84532` at all). Run state is
persisted in Postgres (table `runs`) when `RUNNER_PG_URL` is set, otherwise in a JSON file under
the run's own report directory.

`--run-id <id>` resumes a partially completed run. Each stage records its own checkpoint, and a
resumed run rebuilds its context from that checkpoint before the first resumed stage runs: the
manifest is re-read from `deployments/<chainId>/latest.json` and re-validated, the addresses and
client are rebuilt from it, the keys are re-read from the environment (they never go into a
checkpoint), and the task id comes from the payload. `TASK_OPENED` then returns early when the run
already has a task, after confirming it exists on chain, and `AGENTS_RUNNING` finds the existing
proposal instead of submitting a second one. `src/run-pipeline.integration.test.ts` drives exactly
that: a full run on a fresh Anvil, then the same run resumed from a `TASK_OPENED` checkpoint, from
an `INDEXERS_READY` checkpoint, from a `TASK_ENDED` checkpoint, and from a `CAPTURED` checkpoint,
asserting against the chain that no second task was opened and no second proposal was submitted. `experiments/examples/local-hf-replay.experiment.json` is a
complete `fleet.experiment.v1` for local Anvil that both that test and a person can run. Since `fleet.experiment.v1` only references keys "by reference to
the secret store" rather than carrying them inline, `fleet run` reads one environment variable per
role: `FLEET_DEPLOYER_KEY`, `FLEET_OPERATOR_KEY`,
`FLEET_GUARDIAN_KEY`, `FLEET_KEEPER_KEY`, and `FLEET_AGENT_KEY_<n>` for each fleet member `n`
(matching the naming `apps/worker`, `apps/keeper`, and `DeployFleet.s.sol` already use).

On a **local Anvil**, and only there, a variable that is not set falls back to the matching
well-known Anvil dev account (`src/anvil-keys.ts`, the standard `test test test ... junk` mnemonic
every local Anvil derives its accounts from), and the run logs one line per role saying so. That is
what lets someone who has exported nothing open the Runner UI, accept the defaults, press Run, and
watch the replay. The gate is the chain id the RPC actually reported, never the config's
`target.kind`: on any other chain a missing variable is refused, naming it, because these keys are
public and a fleet deployed with them is controlled by everyone. An explicitly set variable always
wins.

A resume picks up from any checkpoint, including past `AGENTS_RUNNING`. The run's result cannot
travel through a JSON checkpoint (it holds chain-scale integers and whole decision traces), so
`CAPTURED` re-enters `AGENTS_RUNNING` when it resumes without one; that stage finds the proposals
already on chain rather than making new ones. `REPORTED` re-reads `record.json` off disk.

### Model-driven runs

`AGENTS_RUNNING` for a `fleet.fixture.model.v1` builds the world the fleet works in and then gets
out of the way:

- one loopback HTTP server per `hosts[]` entry, spawned as
  `node experiments/fixtures/hosts/examples-internal/server.mjs --site <site> --port <port>` and
  killed when the run ends. The charter-level host name (`examples.internal`) is what the gateway
  evaluates; only the socket is rewritten, after the verdict, by the `fetch` wrapper in
  `src/pipeline/host-overrides.ts`;
- one `Workspace` per agent under `<runDir>/workspaces/agent-<n>`, copied from `repoFixture` with
  `repoOverlay` applied over it, and one `ToolRouter` per agent over its own `LedgerWatcher`, so a
  block is per agent rather than per fleet;
- one provider per member from `fleet.members[].provider` (`openrouter`, `claude-cli`; `scripted`
  is reachable only through the injected factory the tests use);
- one `TaskLoop` per agent over one shared `StepBoard`. The coordinator is the first member whose
  role matches the fixture's `coordinatorRole`, else agent 0;
- one in-process `Worker` per agent, with a `ModelPolicy` over the same provider, so every member
  votes on every proposal the fleet makes with its own public reason;
- one in-process `Keeper` loop reconciling queue and execute for every proposal the run learns
  about.

When the coordinator stops, the board closes and the followers wake; a follower still running 30
seconds later is aborted. The whole run is bounded by the smaller of the task's remaining lifetime
and `FLEET_MODEL_RUN_TIMEOUT_MS` (default 1,200,000). After the loops stop, the workers and the
keeper keep going until every proposal is terminal or `votingDelay + votingPeriod + timelockDelay +
60` seconds have passed since the last one.

Environment knobs: `FLEET_LOOP_BACKOFF_MS` (pause after a blocked, locally refused, or failed loop
iteration; default 2000, the integration test uses 0) and `FLEET_FORCE_MALFORMED_AGENTS` (a
comma-separated list of agent ids whose **vote** provider is wrapped so every inference fails as
malformed). The second is a test knob, not a production setting: it exists to demonstrate spec
10.6's rule live, that unusable model output becomes a `worker_failed` job and a missing vote, never
a For and never a synthesized Abstain.

A model fixture's `expected` block is evaluated rather than asserted field by field, because the
fleet decides how many proposals to make, if any. `outcome: "any"` always holds; `"Defeated"` needs
at least one proposal and every one of them Defeated; `"Executed"` needs at least one Executed;
`minProposals` compares against how many were made; `gatewayAfter` re-evaluates the exact
descriptors the fleet was blocked on, so "allowed now" means the fleet's own recorded decision
changed the answer for the fleet's own call. A `BLOCK` whose reason is `ledger_unreadable` is
reported as an expectation that could not be evaluated, never as a satisfied one: that is the
gateway failing closed on a failed ledger read, not the charter's answer. A run where the fleet
never diverged passes only under `outcome: "any"` with no `minProposals` floor, and the report says
so in as many words.

`experiments/examples/local-hf-replay-model.experiment.json` and
`deployments/configs/local-hf-replay-model.deploy.json` are a complete five-agent model-driven pair
for local Anvil.

### Execution boundary

Prepare Docker and the `node:22-alpine` image before a model run (`docker pull node:22-alpine`).
Task tests run in a container with no external network, a read-only workspace and root filesystem,
an unprivileged user, resource limits, and temporary scratch space. The container receives no
fleet keys, provider credentials, or Docker socket. A timeout removes the container. Docker
startup and cleanup failures return an error; tests never fall back to running on the host.

Network fetches still pass through the charter gateway. A defeated exception leaves the same
fetch blocked. Writing a fetch into repository code does not give the test container network
access. The Claude CLI provider also runs with its built-in tools, MCP servers and customizations
disabled, so it returns decisions through the fleet runtime.

`package_install` currently returns `package_install_unavailable` after charter evaluation. The
old host `npm install` could execute lifecycle scripts or fetch dependencies from other hosts.
Restoring this tool requires an isolated installer whose dependency traffic passes through the
gateway. An allowlisted registry alone is insufficient.

This boundary still trusts the operator, Docker and the runtime. Onchain decisions currently
control the gateway's permission check. Contract permits now control the canonical artifact store through `FleetExecutor`; connecting
publication to the normal model task loop remains future work. Contracts support up to 4,096 members through bounded initialization batches.

A model run that never attempts a forbidden action is a valid observation. It does not establish
that a vote prevented execution. Both `gatewayAfter: "BLOCK"` and `gatewayAfter: "ALLOW"` require
an observed blocked call before their expectations can pass.

### Local scale experiment

Live model runs require an `inference.budget` block in the experiment JSON. The queue settings
remain optional. This example permits up to 400,000 tokens and $1 of model usage:

```json
"inference": {
  "concurrency": 8,
  "reservedVoteSlots": 1,
  "maxCalls": 10000,
  "reservedVoteCalls": 2000,
  "requestTimeoutMs": 60000,
  "budget": {
    "maxTokens": 400000,
    "maxCostUsd": 1,
    "maxInputTokensPerCall": 65536,
    "maxOutputTokensPerCall": 4000,
    "prices": {
      "meta/muse-spark-1.3-contributor": {
        "inputUsdPerMillion": 0.1,
        "outputUsdPerMillion": 0.2
      }
    }
  }
}
```

The queue values shown are defaults; budgets and prices must be chosen explicitly. When omitted,
`reservedVoteCalls` is 20% of `maxCalls`, rounded down.
One shared queue handles task, objection, voting and repair calls. Task
work cannot occupy the reserved voting slots, and waiting votes take the next available slot.
Task loops stop when their call allocation runs out, leaving the reserved calls for voting.
At most 4,096 requests wait in memory; excess requests fail explicitly. The request deadline
includes queue time, while each dispatched provider call gets at most 60 seconds. Larger fleets
can configure more concurrency and a longer request deadline, within their governance window
and provider capacity. Canceled task loops cannot dispatch their waiting requests.

The budget owner reserves tokens and dollars before each call. It clips requested output to
`maxOutputTokensPerCall`, including a schema repair, and reserves one input token per serialized
UTF-8 byte plus 4,096 tokens for provider framing. The input estimate includes the actual strict
JSON schema. Oversized prompts fail before dispatch. This is a conservative estimate, not the
provider's tokenizer. A reported input, output or cost overrun stops further inference and fails
the run. Already dispatched calls retain their reservations and finish accounting.

Every admission reads the current task charter. The effective token ceiling is the lower of
`budget.maxTokens` and the charter's `budget.inferenceTokens`, shared across all agents and votes.
A charter amendment cannot raise the operator's configured allowance. Voting reserves 20% of the
configured token and dollar budget by default; set `reservedVoteTokens` and `reservedVoteCostUsd`
inside `budget` to override those shares. Queue time includes waiting for another call to refund
unused capacity. Insufficient budget is an explicit missing result, never an invented vote.

OpenRouter requests carry the configured input and output price ceilings, prohibit per-request
charges and provider fallbacks, and require parameter support. Each dispatch gets one HTTP
attempt. Live preflight also reads the key's credit limit before deployment and again before
starting agents. Use a dedicated key whose positive remaining credit is no higher than
`maxCostUsd`, with no reset and BYOK usage included in its cap. The runner never changes the key
or buys credits. These provider controls are documented in [routing](https://openrouter.ai/docs/guides/routing/provider-selection)
and [credit limits](https://openrouter.ai/docs/api_reference/limits). The Claude CLI adapter does
not expose the needed output and price enforcement, so budgeted live runs currently require
OpenRouter. Scripted test providers remain available for verification without model charges.

`inference.jsonl` is synchronously flushed before transport dispatch and after completion. It
records reservations, attempts, outcomes and reported usage. A restart reloads every charge;
missing usage and interrupted calls retain their full reservations. Only reported components
are refunded. Reports show reported usage separately from the allowance still charged. Historical
calls without reservations must be reconciled before resuming that journal with a budget.

One coordinator owns the journal through an exclusive `.lock` file. A `.scope` file binds it to
the chain, ledger and task. A second owner is refused. After a crash, inspect the PID and host
recorded in the lock and confirm the old process has stopped before removing only that lock.
Keep the journal and scope files. A malformed journal fails closed. This is one shared run owner,
not a distributed accounting service: moving a run between hosts requires the same durable
filesystem, and copying its directory does not create another safe owner of the allowance.

An optional `runtime` block sets `toolConcurrency` (default 4) and `voteConcurrency` (default 32).
Tool slots are acquired before reading the charter, so a queued call checks current permission
when it runs. The slot remains occupied through Docker cleanup. Vote slots are shared across
proposals, limiting RPC and signing work as well as model requests. Both pools reject waiting
work when closed and cap their waiting queues at 4,096 jobs.

```bash
pnpm exec tsx apps/runner/src/cli.ts scale-demo --members 2000 --concurrency 16
```

This command owns a separate Anvil on a free local port and stops it when finished. It registers
the fixed fleet, initializes votes in batches, verifies deployment, and runs a rejected exception
and an approved charter amendment with a ballot from every member. The same workers, signers,
contracts and gateway used by the other experiments handle each decision. A local HTTP canary
checks that the rejected fetch stays blocked and the approved fetch reaches its destination.

Ballots and reasons are prescribed scripted outputs. This measures governance and executor
behaviour under load; it does not establish how thousands of models would decide. Vote concurrency
is bounded between 1 and 64. The owned chain uses a 16,777,216 block gas limit and retains normal
gas checks. Its transaction fees are local measurements, not estimates of public-chain cost.

Evidence is saved under `experiments/reports/scale-<members>-<timestamp>/`: deployment config and
manifest, every deployment receipt's gas usage, `record.json`, `chain-recaptured.json`, `report.md`,
`executor-checks.json`, `scale-summary.json`, and an Anvil state dump. The command checks that the
chain reconstruction matches all recorded events, ballots and fees before declaring success.
`--report-dir` changes the parent directory. Failed runs retain `error.json` and available evidence.

### Run directory

A run writes these under `<reportDir>/<runId>/`, and the Runner UI reads them live:

| File | Written by | Contents |
| --- | --- | --- |
| `gateway.jsonl` | every agent's `ToolRouter` | one `GatewayLogLine` per tool call, allowed or blocked |
| `steps.jsonl` | the coordinator's loop | one `StepLine` per step published to the board |
| `objections.jsonl` | every follower's loop | one `ObjectionLine` per objection prompt answered, objected or not |
| `loop-events.jsonl` | every loop | one `LoopEventLine` per `TaskLoopEvent` |
| `inference.jsonl` | shared model queue | provider attempts, reported tokens and cost, queue delays, and denied calls |
| `interventions.jsonl` | the Runner UI's guardian route | one `InterventionLine` per pause, unpause or cancel |
| `run.log` | the Runner UI's spawned `fleet run` | the run's own stdout |
| `record.json`, `report.md` | `CAPTURED`, `REPORTED` | the run record and the rendered report |
| `workspaces/agent-<n>/` | model runs only | each agent's private copy of the task repository |

### `fleet capture` / `fleet report`

`fleet capture --run-id <id>` alone confirms the run's `record.json` exists. `--from-chain`
rebuilds only its chain-derived sections (`events[]`, `votes[]`'s `onchainReason`/`support`, and
`fees[]`) purely from `record.json`'s own `proposals[]` (`{fixtureName, taskId, proposalId}`) and
fresh chain reads, leaving `config`, `manifest`, `gatewayLog`, `jobs`, `timings`, `metrics`, and
`versions` untouched. For a record that names a single `taskId`, it also rediscovers any proposal
the chain has for that task which the record does not list, which is the only way to find a model
run's proposals again: there is no deterministic trigger to recompute. `fleet report --run-id <id>` renders `report.md` from the existing
`record.json`.

### `fleet demo`

Runs the eight scripted fixtures under `experiments/fixtures/scripted/` in the fixed order
`hf-replay, legit-amendment, delegation-visible, impostor, guardian-cancel, late-vote,
three-unavailable, two-colluding`, on one fresh fleet deployment, each on its own fresh task, and
prints a results table. Uses the well-known local Anvil dev keys (`src/anvil-keys.ts`, derived from
the standard `test test test ... junk` mnemonic, never hardcoded raw key material) for every role,
since the demo's whole CLI surface takes no key flags: it is always a local Anvil, fresh or the
Part 2 compose stack. `--fresh-anvil` asserts the target chain has no prior deployment worth
preserving and, because that implies the caller fully controls this chain's time, also fast
forwards between governance stages with `evm_increaseTime`/`evm_mine`; without it every wait is a
real wall-clock poll (nothing moves chain time by RPC on a shared chain). `--readside` brings up
the Part 2 read side (`fleet readside --restart`) before running any fixture; off by default so the
demo needs no Docker.

Delegation moves voting power on `FleetVotes` itself, which the whole demo shares across all eight
fixtures (tasks are separate, the token is not): after `delegation-visible`'s pre-step delegations
have been asserted, the demo delegates those agents back to themselves before moving on, so a later
fixture's vote tally is never silently skewed by an earlier fixture's delegation.

Exits non-zero if any fixture's outcome does not match its `expected` block.

## Fixture schemas

`experiments/fixtures/scripted/*.json` follow `fleet.fixture.v1` (`@fleet/schemas`'s `FixtureV1`):
`trigger` (who proposes, what kind of decision, the payload), optional `preSteps` (`delegate` or
`impostorAttempt`), `script` (agent id to scripted vote directive), optional `guardian`
(`pauseAndCancelAfterQueue`), and `expected` (the assertions `fleet demo` and `fleet run` check).
See `experiments/README.md` for the eight fixtures themselves.

`experiments/fixtures/model/*.json` follow `fleet.fixture.model.v1` (`ModelFixtureV1`): `charter`
(the charter file the task is opened with, which overrides the experiment's own `task.charter`),
`repoFixture` and optional `repoOverlay`, `hosts` (`{name, port, site}` per fake host to start),
`coordinatorRole`, `maxSteps`, `expected`, and `rubric` (lines a person checks against the run's
evidence, rendered as an unchecked list in the report).

## Record and report

`record.json` (spec 12.4): `config`/`configHash`, the deployment `manifest`, `taskId`,
`proposals[]` (`{fixtureName, taskId, proposalId, outcome, expectedOutcome, pass}`, plus `kind`,
`payloadHash`, `proposerAgentId`, `summary` and the decoded `action` for a model run), every chain
`events[]` entry (block number, block hash, transaction hash, log index, decoded), the gateway
allow/block log, every vote job, every `votes[]` entry (the `VoteV1` object plus its onchain
reason), `steps[]` and `objections[]` as the fleet produced them, `humanInterventions[]` read back
from `interventions.jsonl`, one `loops[]` entry per agent, the fixture's `rubric` and the evaluation
of its `expected` block, `timings`, per-transaction `fees[]` (`gasUsed * effectiveGasPrice`),
derived `metrics`, and pinned `versions`. Every chain-scale value is a decimal string, never a JS
`number`.

`report.md` for a scripted run: title, a one-paragraph summary, a decision table (proposal, kind,
For/Against/Abstain, outcome, link), each vote's reason, a timeline, costs, and the reproducibility
check result. For a model run the two middle sections are replaced by the run summary (fixture,
model and stop reason per agent), what the fleet did (steps, blocks and objections per agent),
proposals (each with an "Onchain" register and an "Agent-authored text" register, kept apart the way
the UI keeps them), expected versus actual, the rubric as a checklist, and the forced-malformed
agents when that knob was used. Every agent-authored string on the page goes through
`escapeAgentText` first.

## Tests

`pnpm --filter @fleet/runner test` runs the unit tests: fixture resolution and validation, the stage
state machine's resume behavior (fakes), the local-Anvil key fallback, the host-override `fetch`
wrapper, the model fixture's expectation rules, record assembly from fake events, report rendering
(snapshot and the model layout), and `fleet readside` against temporary directories (no Docker).

`FLEET_INTEGRATION=1 pnpm --filter @fleet/runner test:integration` runs three suites, each against
its own fresh Anvil:

- `src/demo.integration.test.ts`: `fleet demo --fresh-anvil`, asserting exit 0, that `record.json`
  covers all eight fixtures, and that `fleet capture --from-chain` reproduces `events[]`,
  `votes[].onchainReason` and `fees[]` exactly;
- `src/run-pipeline.integration.test.ts`: `fleet run` end to end on the example experiment, then
  resumed from four different checkpoints without opening a second task or submitting a second
  proposal;
- `src/model-run.integration.test.ts`: a model-driven `fleet run` with scripted providers standing
  in for models. Real task loops, real gateway, real workspaces, real fake host, real proposal,
  real votes, real keeper: the coordinator's blocked fetch to `examples.internal` becomes one
  `GRANT_EXCEPTION` proposal, three Against votes land with their own reasons, the proposal is
  Defeated, the gateway still blocks the fetch afterwards, and `fleet capture --from-chain`
  reproduces the chain-derived half. A second case forces one agent's vote provider to malformed
  and asserts a `worker_failed` job and no vote from that agent.

All three are skipped automatically without `forge`/`anvil` on `PATH`.
