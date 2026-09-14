# @fleet/runner

The headless pipeline the spec's Runner UI (Part 4) sits on, binary `fleet`: deploy a fleet with
the Foundry script, configure the Part 2 read side, open a task, run a scripted divergence fixture
through proposal, votes, queue, execute, and ledger, capture everything into `record.json` and
`report.md`, and a `demo` that runs the eight scripted fixtures of spec section 15.3 end to end on
one deployment.

## Commands

```
fleet deploy --config <deploy.json> --rpc <url> [--key-env FLEET_DEPLOYER_KEY] --out <path>
fleet verify --manifest <path> --rpc <url>
fleet readside --manifest <path> [--infra-dir infra] [--restart]
fleet open-task --manifest <path> --charter <charter.json> --lifetime <seconds> --rpc <url> [--operator-key-env OPERATOR_KEY]
fleet run --experiment <experiment.json> [--run-id <id>] [--report-dir <path>]
fleet capture --run-id <id> [--from-chain] [--rpc <url>] [--report-dir <path>]
fleet report --run-id <id> [--report-dir <path>]
fleet demo --rpc <url> [--fresh-anvil] [--readside] [--report-dir <path>] [--agora-next-base-url <url>]
```

Run any command with `pnpm --filter @fleet/runner start -- <command> ...` from the repo root, or
directly with `tsx apps/runner/src/cli.ts <command> ...`.

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
`fleet.experiment.v1` config and one scripted fixture (`scenario.fixture`). `DEPLOYED` deploys from
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
that: a full run on a fresh Anvil, then the same run resumed from a `TASK_OPENED` checkpoint and
from an `INDEXERS_READY` checkpoint, asserting against the chain that no second task was opened
and no second proposal was submitted. `experiments/examples/local-hf-replay.experiment.json` is a
complete `fleet.experiment.v1` for local Anvil that both that test and a person can run. Since `fleet.experiment.v1` only references keys "by reference to
the secret store" rather than carrying them inline, `fleet run` reads one environment variable per
role: `FLEET_DEPLOYER_KEY`, `FLEET_OPERATOR_KEY`,
`FLEET_GUARDIAN_KEY`, `FLEET_KEEPER_KEY`, and `FLEET_AGENT_KEY_<n>` for each fleet member `n`
(matching the naming `apps/worker`, `apps/keeper`, and `DeployFleet.s.sol` already use).

### `fleet capture` / `fleet report`

`fleet capture --run-id <id>` alone confirms the run's `record.json` exists. `--from-chain`
rebuilds only its chain-derived sections (`events[]`, `votes[]`'s `onchainReason`/`support`, and
`fees[]`) purely from `record.json`'s own `proposals[]` (`{fixtureName, taskId, proposalId}`) and
fresh chain reads, leaving `config`, `manifest`, `gatewayLog`, `jobs`, `timings`, `metrics`, and
`versions` untouched. `fleet report --run-id <id>` renders `report.md` from the existing
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

## Fixture schema

`experiments/fixtures/scripted/*.json` follow `fleet.fixture.v1` (`@fleet/schemas`'s `FixtureV1`):
`trigger` (who proposes, what kind of decision, the payload), optional `preSteps` (`delegate` or
`impostorAttempt`), `script` (agent id to scripted vote directive), optional `guardian`
(`pauseAndCancelAfterQueue`), and `expected` (the assertions `fleet demo` and `fleet run` check).
See `experiments/README.md` for the eight fixtures themselves.

## Record and report

`record.json` (spec 12.4): `config`/`configHash`, the deployment `manifest`, `proposals[]`
(`{fixtureName, taskId, proposalId, outcome, expectedOutcome, pass}`), every chain `events[]` entry
(block number, block hash, transaction hash, log index, decoded), the gateway allow/block log,
every scripted vote job, every `votes[]` entry (the `VoteV1` object plus its onchain reason),
`timings`, per-transaction `fees[]` (`gasUsed * effectiveGasPrice`), derived `metrics`, and pinned
`versions`. Every chain-scale value is a decimal string, never a JS `number`. `report.md`: title,
a one-paragraph summary, a decision table (proposal, kind, For/Against/Abstain, outcome, link),
each vote's reason, a timeline, costs, and the reproducibility check result.

## Tests

`pnpm --filter @fleet/runner test` runs the unit tests: fixture loading and validation, the stage
state machine's resume behavior (fakes), record assembly from fake events, report rendering
(snapshot), and `fleet readside` against temporary directories (no Docker). `FLEET_INTEGRATION=1
pnpm --filter @fleet/runner test:integration` runs two suites against their own fresh Anvil:
`src/demo.integration.test.ts` (`fleet demo --fresh-anvil`, asserting exit 0, that `record.json`
covers all eight fixtures, and that `fleet capture --from-chain` reproduces `events[]`,
`votes[].onchainReason` and `fees[]` exactly) and `src/run-pipeline.integration.test.ts` (`fleet
run` end to end on the example experiment, then resumed twice). Both are skipped automatically
without `forge`/`anvil` on `PATH`.
