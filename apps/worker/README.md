# @fleet/worker

A thin long-running process over `@fleet/agent-runtime`'s `Worker`, for exactly one fleet agent
per process. Every `FLEET_POLL_MS` it lists every `ProposalCreated` log on the governor from the
fleet manifest's `deploymentBlock` to the chain tip, and for each proposal id not already known
done, reads its current governor state. Only an `Active` proposal is handed to
`Worker.handleProposal`, which runs the full discover-evaluate-validate-simulate-sign-submit-
confirm pipeline for this agent and persists every transition, so a restart never double-votes.

## Running

```
pnpm --filter @fleet/worker start
```

One process handles exactly one agent. Run one process per agent (distinct `FLEET_AGENT_ID` and
`FLEET_AGENT_KEY`) to cover a whole fleet.

## Environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `FLEET_MANIFEST` | yes | | Path to a `fleet.manifest.v1` JSON file (parsed with `@fleet/schemas`'s `ManifestV1`). |
| `FLEET_RPC_HTTP` | yes | | HTTP JSON-RPC URL for the chain the manifest was deployed to. |
| `FLEET_AGENT_ID` | yes | | This process's 0-based fleet registry agent id. |
| `FLEET_AGENT_KEY` | yes | | 0x-prefixed 32-byte private key this agent votes with. Never logged. |
| `FLEET_POLICY` | yes | | `scripted:<FOR\|AGAINST\|ABSTAIN\|ABSENT\|MALFORMED\|LATE>`. Builds a `ScriptedPolicy` scripted for this agent's id only. |
| `RUNNER_PG_URL` | no | | Postgres connection string. When set, nonces and job records use `PgNonceStore`/`PgJobStore` (migrated on startup). When unset, `MemoryNonceStore`/`MemoryJobStore` are used and a warning is logged: neither survives a restart. |
| `FLEET_POLL_MS` | no | `2000` | Poll interval in milliseconds. |
| `FLEET_SUBMISSION_MARGIN_SEC` | no | `20` | Seconds of voting window that must remain before this worker will submit a vote (`Worker`'s own submission-margin check). |
| `LOG_LEVEL` | no | `info` | pino log level. |

## Logging

Structured JSON lines via `pino`. Every handled proposal logs the proposal id, the governor's
`ProposalState`, and the resulting job state (or `null` when the proposal was not `Active` this
poll); a failure logs the proposal id and an `explainRevert`-rendered message. This agent's
private key is never logged.

## Shutdown

`SIGINT`/`SIGTERM` finish whatever poll is currently in flight, then exit `0`.

## Tests

`pnpm --filter @fleet/worker test` runs the unit tests (env parsing, the discovery/handle loop
against a fake client). `FLEET_INTEGRATION=1 pnpm --filter @fleet/worker test:integration` runs
`src/fleet-smoke.integration.test.ts`, a cross-app smoke test: it starts a local Anvil, deploys
the fleet contracts with the Foundry script, opens a task, proposes a decision as agent 0, spawns
three `@fleet/worker` child processes (agents 1, 2, 3, all `scripted:FOR`) and one `@fleet/keeper`
child process (via each app's own `pnpm start`), and asserts the proposal reaches `Executed` and
the ledger records the decision. It is skipped automatically without `forge`/`anvil` on `PATH`.
