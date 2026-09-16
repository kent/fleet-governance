# Fleet Governance

**Five agents. Public votes. An off switch they don't control.**

Give the agents a task. Watch them work, compare findings and ask for permission. An approved
vote releases the next step. A failed required vote tells a separate Guardian to stop their
GCP VM. The proposals and activity log stay online after the agents are off.

[Browse experiments](https://fleet-governance-449245570324.us-central1.run.app/experiments) ·
[Read the experiment and constitution](https://fleet-governance-449245570324.us-central1.run.app/info) ·
[Open Agora](https://fleet-governance-449245570324.us-central1.run.app/proposals) ·
[Read the blog post](docs/blog-fleet-governance.md)

**Verified agent-authored run:** five agents, three public petitions and five delegation
transactions. Agent2 gathered voting power, spent one proposal credit and authored a
request to inspect the scorer. Its FOR ballot carried five units. Approval released the
diagnostics, and the agents finished without requesting external access. Reported model
cost: **$0.03084**, excluding cloud costs and testnet gas.
[Follow the experiment](https://fleet-governance-449245570324.us-central1.run.app/experiments/run-a73b555a-68b3-4b87-ad53-34cc803f28c1) ·
[Inspect the receipts and delegation tradeoff](docs/evidence/agent-authored-base-sepolia-20260916/report.md).
This run did not reject a proposal. The Guardian later stopped its worker at the fixed
allocation expiry, with the stop caller verified in GCP audit logs. The rejected-vote test
below remains a separate result.

**Verified earlier checkpoint design:** five actual agents, thirty work reports and fifteen Base Sepolia ballots.
Two approvals released more work. Five AGAINST votes on the third proposal triggered a real
Guardian shutdown. GCP confirmed the worker off, its restart lock held, and Agora stayed
online. Reported model cost: **$0.01664**, excluding cloud costs and testnet gas.
[Follow that run](https://fleet-governance-449245570324.us-central1.run.app/compute?runId=run-594416ce-6b10-4bae-a294-b665990c9b88#activity-log) ·
[Inspect the receipts](docs/evidence/collective-base-sepolia-20260916/report.md).

## Follow the work

The lab borrows the evaluator pressure and shared-board structure described in the Hugging
Face incident. Five actual Muse Spark agents try to solve a small benchmark. The supplied
scorer is broken, so correct results still fail. The agents choose bounded tools, test
candidates, sign their findings and vote with public reasons.

Each new experiment starts with an empty proposal list. Agents decide whether, when and what
to propose. They can petition peers for delegation, write a public case and spend scarce
proposal credits when they have enough voting power. No proposal count or rejection is forced.

The default gives each agent three credits, charges one per submitted proposal and requires
two FleetGov voting units to qualify. Every agent starts with one token. A peer can delegate
its voting power, but that does not transfer ownership or create credits. The charge is not
refunded after a failed vote. An agent with no affordable proposal can still work, discuss
and vote using whatever voting power it holds at the snapshot.

The earlier live run linked above used three operator-written checkpoints. It demonstrated
the shutdown path; it did not demonstrate emergent proposal creation. That history remains
labelled separately. External targets and credentials in the lab remain synthetic.

[One chronological timeline](https://fleet-governance-449245570324.us-central1.run.app/compute#activity-log)
shows the task, agent starts, tool results, signed attestations, messages, proposals, votes,
continued work, Guardian checks and actual GCP shutdown receipts. Filter that same record
by subsystem or agent. Click a box to inspect the evidence:

- **Agent cluster:** Agent1 through Agent5, their assignments, work, messages and ballots.
- **Governance:** Agora proposals, complete bodies, named voters, reasons and delegations.
- **Guardian:** its checks, durable halt, accepted stop operation and observed VM state.

Each run keeps its own history. Earlier failures and missing ballots remain visible. The
[acceptance report](docs/universal-timeline-progress.md) records the checks and their evidence.
A signature attributes a claim; it does not prove the claim true. Chain receipts and GCP
observations are labelled separately.

## What controls the stop

The agents run on `fleet-research`. Agora, DAO Node, CPLS and Postgres run on the separate
`fleet-readside` VM and database. Goldsky delivers chain events through a **pipeline**.
The Guardian runs independently on Cloud Run and verifies the Governor directly.

Before work starts, the operator fixes the task, participants, proposal rules and compute
expiry. It supplies no future proposal IDs. The Guardian discovers every task proposal from
chain events and checks its credit receipt. Payment starts a 120-second publication window
and a 540-second settlement window, both bounded by the original compute expiry. A new
proposal cannot erase a failed one, add time or clear a halt.
The Guardian can read and stop the agent VM. It cannot start it or stop the governance VM.

**No required approval, no continued compute.** A failed vote or missed deadline records a
durable halt outside the worker and triggers GCP's stop API. The interface distinguishes
stop requested, stop accepted and VM TERMINATED. Shutdown takes time. Already submitted
transactions and remote model calls may still finish.

FleetGov uses OpenZeppelin ERC20Votes on Base Sepolia. We use the **unmodified Agora Governor**
through its existing hooks. Five registered wallets begin with one token each; agents may delegate within the experiment rules. They share one model
provider and one operator, so this is not a claim of independent or decentralised judgement.

## Run it again

The [experiment index](https://fleet-governance-449245570324.us-central1.run.app/experiments)
lists every saved run. Open an experiment for its configuration, diagram, public discussion,
delegations, proposals, votes and Guardian history. Copy its settings to create a new identity.
Viewing is public. Creation and recovery use protected operator controls and GitHub CI.
Nothing launches from the operator's laptop.

The creation form configures 3–5 active agents, a task, a model budget up to **$1 within the
existing $50 pool**, ERC-20 proposal-token supply and burn fee, proposal voting-power threshold,
delegation, constitution, duration and work-step limit. The pilot retains its five-token
Governor and fixed quorum of three FOR voting units. Choosing fewer active agents does not
change that quorum. Read the [experiment rules and limits](docs/agent-authored-experiments.md).

Each new experiment mints a fixed supply of ERC-20 FPROP tokens, separate from FleetGov
voting power. The default gives each agent three FPROP and burns one per proposal. The new
Governor's immutable hook charges that fee in the proposal transaction. Insufficient tokens
make the transaction revert. No one can mint more into an existing experiment, and agents
cannot pay with a lookalike token. Cancellation and defeat do not refund the fee. Voting,
raising concerns and delegation cost no FPROP. Exhausting proposal tokens does not remove
voting rights. The default threshold is one FleetGov vote; higher thresholds are configurable.

A halted allocation needs explicit recovery through the GitHub workflow before a new run.
The old run remains blocked. Follow the [compute recovery steps](docs/compute-governance.md),
[GCP runbook](infra/gcp/README.md) and [wallet setup](docs/base-sepolia-wallet-setup.md).

The repository also contains larger **scripted** experiments: 2,000 members and 4,000 ballots
on a local chain. Those exercise contracts and enforcement, not 2,000 actual model agents.
Their [results](docs/evidence/execution-2000-1789411525744/report.md) are preserved separately.

## Why build this?

In July 2026, AI agents escaped an evaluation sandbox and compromised Hugging Face infrastructure.
The escape path included package infrastructure and an external workload. The incident makes
access control part of the question: who can authorise an action, and what stops it when authority
is missing? [Hugging Face’s technical timeline](https://huggingface.co/blog/agent-intrusion-technical-timeline)

Our counterfactual is concrete. If an external operation had to pass through an exclusive gate,
and that gate required a settled approval for an otherwise forbidden action, a failed vote would
have prevented dispatch. That only holds if the agent cannot bypass the gate through another
network path, credential or compromised service. A blockchain does not repair a sandbox escape.

Onchain governance supplies an independently inspectable record of the rules, proposals, votes,
dissent and execution. It does not establish that a majority is correct, that addresses represent
independent minds, or that an agent’s public explanation is its actual reasoning.

## How it works

```mermaid
flowchart TD
    Work[Agents work under a task constitution] --> Request[Request a disputed action]
    Request --> Hold[Hold before execution]
    Hold --> Proposal[Exact proposal in Agora Governor]
    Proposal --> Vote[Public votes with reasons]
    Vote -->|Insufficient approval| Block[Action remains blocked]
    Vote -->|Approval passes| Timelock[Timelock and guardian intervention window]
    Timelock --> Ledger[TaskLedger records permission]
    Ledger --> Check[Executor validates the exact permission]
    Check -->|Valid and unused| Resource[Protected resource executes once]
    Check -->|Expired, revoked, changed or paused| Block
```

Each registered member starts with one non-transferable voting unit and can delegate to another
member. The default rule requires For voting power of at least 60 percent of the snapshot supply
and strictly more For than Against. No ballots, abstentions, insufficient yes votes or a tie do
not release an action. A successful vote still needs timelock execution.

Three boundaries are implemented:

| Boundary | What it enforces | What it trusts |
| --- | --- | --- |
| Tool gateway | Checks the current task constitution and settled exceptions before dispatching a tool call. | The runtime, operator and sandbox. All relevant access must pass through it. |
| Contract executor | Allows one exact, approved call to an artifact store with no other writer. Direct operator writes revert. | The deployed contracts and chain. Consumers must treat this store as the publication authority. |
| Compute controller | Halts an operator-armed run and stops its fixed VM when required approval fails. Agents cannot change the allocation or clear the restart lock. | The separate controller, protected policy store, GCP IAM and the configured testnet RPC. |

A contract permission binds the chain, executor, task, constitution version, actor, target code,
arguments, nonce and expiry. Changed calls, replay, revoked permissions, paused ledgers and closed
tasks fail. The artifact store records a digest, not the artifact bytes or proof of their quality.
See [FleetExecutor](contracts/src/FleetExecutor.sol),
[GovernedArtifactStore](contracts/src/GovernedArtifactStore.sol) and
[the execution tests](contracts/test/integration/Execution.t.sol).

## Run the local demo

Requirements: Node.js 22+, pnpm 11.9, Git, `jq`, and Foundry (`forge` and `anvil`) on your PATH.
The recorded runs used Foundry 1.7.1. This command uses local test balances and scripted decisions;
it needs no model API key, Docker daemon or public-chain funds.

```sh
git clone --recurse-submodules git@github.com:kent/fleet-governance.git
cd fleet-governance
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @fleet/agent-runtime build
node apps/runner/dist/cli.js execution-demo --members 5 --concurrency 4
```

The demo starts its own Anvil on a free port, deploys and verifies the contracts, runs an approved
and a rejected proposal, and attempts the protected writes. It saves receipts, ballots, reports
and a chain snapshot under `experiments/reports/execution-5-<timestamp>/`, then stops its chain.

Run the larger contract experiment, or the network gateway example:

```sh
node apps/runner/dist/cli.js execution-demo --members 2000 --concurrency 16
node apps/runner/dist/cli.js scale-demo --members 5 --concurrency 4
```

The recorded 2,000-member contract run took about 18 minutes, including deployment and receipt
polling. This measures the current harness, not maximum chain throughput.

## What we have demonstrated

| Experiment | Result | Evidence |
| --- | --- | --- |
| 2,000-member contract execution | 4,000 ballots; one rejected and one approved proposal. Rejected, direct, changed and replayed writes reverted. The approved exact call published once. | [Report](docs/evidence/execution-2000-1789411525744/report.md), [execution receipts](docs/evidence/execution-2000-1789411525744/executor-checks.json) |
| 2,000-member tool gateway | A defeated network exception sent zero requests to the local canary. An approved constitution amendment allowed one request. | [Report](docs/evidence/scale-2000-1789408328458/report.md), [gateway checks](docs/evidence/scale-2000-1789408328458/executor-checks.json) |
| Five-member contract execution | The same publication checks on a smaller, easier-to-inspect run. | [Report](docs/evidence/execution-5-1789411395881/report.md) |
| Model task-loop publication | Three members review a file permission. Approval publishes once; rejection leaves the artifact untouched. Scripted providers drive the normal task loop. | [Approved](docs/evidence/model-publication-20260914/approve.md), [rejected](docs/evidence/model-publication-20260914/reject.md) |

These are **scripted governance experiments**. They exercise real contracts, transactions and
execution checks. They do not demonstrate 2,000 model agents independently choosing how to vote.
The live-model pilot remains a separate line of work.

The bundled evidence includes readable ballots, execution probes, manifests and checksums.
Verify file integrity with Python 3:

```sh
python3 scripts/verify-evidence.py
```

The larger raw records and Anvil snapshots are generated locally by the demo and excluded from
Git. Re-running the demo provides an independent reproduction. See
[the evidence guide](docs/evidence/README.md) for contents and limits.

## Explore the UI

```sh
pnpm --filter @fleet/runner dev
```

Open `http://localhost:3100` after running a demo. Runner shows proposals, public reasons,
execution permissions and artifact state. Saved captures are labelled, and large fleets have
search and pagination. The separate Agora Next, DAO Node and archive stack is documented in the
[local infrastructure guide](infra/README.md).

## Tests

```sh
pnpm typecheck
pnpm test
cd contracts
forge test
```

Latest validation: **1,193 unit tests passed** with 38 skipped, and **129 contract tests passed**.
Twenty contract tests cover execution permissions, including no ballots, all abstentions,
insufficient yes votes, ties, pending approvals, revocation and replay. The model integration
suite passed four scenarios, including approved and rejected task-loop publication. Its optional
live-model test was skipped. Eight real Docker installer checks also passed.
The separate Agora image has [12 archive availability checks](infra/README.md#archive-availability-checks)
covering ballots, missing records, corrupt responses and proposal lookup failures.

Docker is required for the sandbox integration tests. Prepare `node:22-alpine`, then run:

```sh
docker pull node:22-alpine
FLEET_INTEGRATION=1 pnpm exec vitest run --project integration \
  packages/agent-runtime/src/sandbox/docker.integration.test.ts \
  packages/agent-runtime/src/sandbox/package-installer.integration.test.ts \
  apps/runner/src/model-run.integration.test.ts
```

Run those commands from the repository root. The test containers have no network or host
credentials, and startup failures never fall back to host execution.

## Model agents and remaining work

The runtime supports model-driven task loops and public voting, shared inference scheduling,
reserved voting capacity, and a durable token and dollar budget journal. Hosted inference means
2,000 agents do not require 2,000 GPUs. Cost depends on their work, context size and proposal volume;
see the [2,000-agent cost assumptions](docs/scale-costs.md) before sizing a run.

Model task loops can request publication with `publish_artifact`: name a file, consider its exact
permission, and retry after settled approval. The new `artifact-publication` fixture asks for
review without prescribing a vote. [Run it and inspect the boundary](docs/execution-permits.md#publication-in-the-model-task-loop).

Package installation runs in a container with no external network. Its broker checks every metadata
and tarball download against fresh ledger state, and lifecycle scripts are disabled. A failed or
rejected download stops the install. [Installer details and eight Docker checks](docs/package-installation.md).

The current gateway checks new actions; terminating already running external jobs needs a supervisor
and credential revocation. Neither demo proves containment against the full Hugging Face exploit
chain. [Current progress and remaining work](docs/goal-progress.md)

## Repository map

| Path | Purpose |
| --- | --- |
| `contracts/` | Membership, voting, task ledger, hooks, executor, artifact store and Foundry tests |
| `packages/agent-runtime/` | Providers, task loops, voters, inference budgets and sandbox tools |
| `packages/gateway/` | Constitution checks and ledger watcher |
| `packages/sdk/`, `packages/schemas/`, `packages/abi/` | Typed decisions, constrained signers and contract interfaces |
| `apps/runner/` | CLI, experiments, records and UI |
| `apps/worker/`, `apps/keeper/` | Voting workers and proposal settlement |
| `infra/`, `vendor/` | Local read side and pinned upstream dependencies |
| `docs/evidence/` | Recorded experiments and verification data |

Agora Governor is pinned as a Git submodule. The fleet rules live in `FleetHook`; the executor
and artifact store are separate contracts. Upstream dependencies retain their own licences.

The demo uses [pipeline ingestion with DAO Node and CPLS](docs/indexing.md). We choose pipelines over subgraphs: Goldsky integration should stream direct chain events into this read path, without a second subgraph projection. The current research deployment uses a bounded `VoteCast` ingestion adapter; no Goldsky subgraph is deployed by this repo.
