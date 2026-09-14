# @fleet/keeper

A thin long-running process over `@fleet/sdk`'s `Keeper`. Every `FLEET_POLL_MS` it lists every
`ProposalCreated` log on the governor from the fleet manifest's `deploymentBlock` to the chain
tip, and calls `Keeper.reconcileProposal` on each proposal id it has not already watched to a
terminal outcome (`executed`, `defeated`, or `canceled`). `reconcileProposal` itself queues a
`Succeeded` proposal and executes a `Queued` one once its timelock ETA has passed; every other
state is a no-op for this poll.

## Running

```
pnpm --filter @fleet/keeper start
```

## Environment

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `FLEET_MANIFEST` | yes | | Path to a `fleet.manifest.v1` JSON file (parsed with `@fleet/schemas`'s `ManifestV1`). |
| `FLEET_RPC_HTTP` | yes | | HTTP JSON-RPC URL for the chain the manifest was deployed to. |
| `FLEET_KEEPER_KEY` | yes | | 0x-prefixed 32-byte private key the keeper signs `queue`/`execute` transactions with. Never logged. |
| `RUNNER_PG_URL` | no | | Read for parity with the worker's environment. The keeper has no durable state of its own: `Keeper.reconcileProposal` re-reads proposal state and re-simulates immediately before every send, so a restart never needs to recover in-flight bookkeeping. When unset, the keeper logs a warning and continues; when set, it logs that the value is unused. |
| `FLEET_POLL_MS` | no | `2000` | Poll interval in milliseconds. |
| `LOG_LEVEL` | no | `info` | pino log level. |

## Logging

Structured JSON lines via `pino`. Every reconciliation attempt logs the proposal id and the
`KeeperResult` (`noop`, `queued`, `executed`, `defeated`, `canceled`, or `waiting`); a failed
reconciliation logs the proposal id and an `explainRevert`-rendered message. The keeper's private
key is never logged.

## Shutdown

`SIGINT`/`SIGTERM` finish whatever poll is currently in flight, then exit `0`.

## Tests

`pnpm --filter @fleet/keeper test` runs the unit tests (env parsing, the discovery/reconcile
loop against a fake client). `FLEET_INTEGRATION=1 pnpm --filter @fleet/worker test:integration`
runs the cross-app smoke test that exercises this app together with `@fleet/worker` against a
real Anvil chain (see `apps/worker/README.md`); it is skipped automatically without `forge`/
`anvil` on `PATH`.
