# Base Sepolia deployment runbook

This runbook is documentation only. Nothing in it has been run against Base Sepolia. Every
command and every environment variable name below is copied from the Runner CLI's own `--help`
output, from `apps/runner/src/cli.ts` and its pipeline modules, from `infra/.env.example`, and
from `infra/README.md`, `docs/compatibility-notes.md`, and `docs/spec.md`.

## 1. Purpose and scope

This runbook takes the owner from a funded Base Sepolia setup to a published pilot deployment
(spec 14, milestone M4). It covers Base Sepolia only. Base mainnet is out of scope: see section 10.

## 2. Inputs the owner supplies

| Input | Format | Used by |
| --- | --- | --- |
| RPC HTTP endpoint (Base Sepolia, chain id 84532) | `https://...` URL | `fleet deploy/verify/run --rpc` and `target.rpcHttp`; `infra/.env`'s `DAO_NODE_ARCHIVE_NODE_HTTP`, `ANVIL_RPC_URL`, `NEXT_PUBLIC_FORK_NODE_URL` |
| RPC WebSocket endpoint | `wss://...` URL | `fleet run`'s `target.rpcWs`; `infra/.env`'s `DAO_NODE_REALTIME_NODE_WS` |
| Provider's `eth_getLogs` range limit | integer (blocks) | must be at least `DAO_NODE_ARCHIVE_NODE_HTTP_BLOCK_COUNT_SPAN` (2000 by default); lower `DAO_NODE_ARCHIVE_NODE_HTTP_BLOCK_COUNT_SPAN` in `infra/.env` if the provider caps it below 2000 |
| GCS bucket name | string | `infra/.env`'s `GCS_BUCKET_NAME` |
| GCS service account JSON key | file path on the host | `infra/.env`'s `GCS_CREDENTIALS_FILE` |
| Deployer private key | `0x` + 64 hex chars | `FLEET_DEPLOYER_KEY` |
| Operator private key | same | `FLEET_OPERATOR_KEY` (`fleet run`); standalone `fleet open-task` reads `OPERATOR_KEY` by default, see section 4 |
| Guardian private key | same | `FLEET_GUARDIAN_KEY` |
| Keeper private key | same | `FLEET_KEEPER_KEY` |
| N agent private keys (N = 5 recommended, matching `deployments/configs/local-5.json`'s shape) | same | `FLEET_AGENT_KEY_0` .. `FLEET_AGENT_KEY_<N-1>` |
| `OPENROUTER_API_KEY` | string | only needed once model-driven agents are wired in; see section 6 |
| Test ETH for every key above | Base Sepolia ETH | checked by the Runner's PREFLIGHT stage (section 3) |

All keys are environment variables. None of them are ever written into a config file or a
manifest; only the derived public addresses go into `deployments/configs/sepolia-5.json`.

## 3. One-time setup

**Bucket and IAM.** Create a GCS bucket. Grant public read on the bucket or on its `data/`
prefix, since Agora Next reads the archive with unauthenticated GETs and a private bucket fails
silently (empty pages, no error):

```
gcloud storage buckets add-iam-policy-binding gs://<bucket> \
  --member=allUsers --role=roles/storage.objectViewer
```

Create a service account with write access to the bucket, download its JSON key, and note the
local path. `GCS_CREDENTIALS_FILE` authenticates only CPLS's writes; it does not gate reads.

**RPC.** Get HTTP and WSS endpoints from a provider. Confirm its `eth_getLogs` range cap, since
DAO Node backfills the archive in windows of `DAO_NODE_ARCHIVE_NODE_HTTP_BLOCK_COUNT_SPAN` blocks
(2000 by default).

**Keys.** Generate or obtain one key per role plus N agent keys. Put them in the repo-root `.env`
(gitignored), never in a deploy config or a manifest. Derive each key's address for the deploy
config with `cast wallet address --private-key <key>`.

**Funding.** Fund every key with Base Sepolia test ETH before running anything. Qualitatively:
the deployer pays for the deployment transaction; each agent pays for one propose or one vote per
divergence; the keeper pays to queue and execute; the guardian pays only when it intervenes. The
Runner's PREFLIGHT stage checks every one of these balances (deployer, operator, guardian, keeper,
every agent) and fails the run outright if any of them is zero, so fund the guardian and keeper
too, even though they transact rarely.

**Read-side env.** Copy `infra/.env.sepolia.example` to `infra/.env` and fill in the RPC URLs,
the bucket name, and the credentials file path. See section 5 for every key.

## 4. Deploy and verify

Create `deployments/configs/sepolia-5.json`, a `fleet.deploy.v1` config, either by hand or from
the Runner UI's config panel (Task 5; not built as of this runbook, documented in section 6). Its
shape matches `deployments/configs/local-5.json`:

```json
{
  "schema": "fleet.deploy.v1",
  "tokenName": "Fleet Vote",
  "tokenSymbol": "FLEET",
  "members": ["<agent-0-address>", "<agent-1-address>", "<agent-2-address>", "<agent-3-address>", "<agent-4-address>"],
  "agentManifests": ["{...}", "{...}", "{...}", "{...}", "{...}"],
  "fleetManifest": "{\"experiment\":\"sepolia-5\",\"constitution\":\"fleet.constitution.v1\",\"harness\":\"sepolia\"}",
  "operator": "<operator-address>",
  "guardian": "<guardian-address>",
  "votingDelay": 60,
  "votingPeriod": 600,
  "proposalThreshold": "1000000000000000000",
  "quorumNumerator": 6000,
  "timelockDelay": 60,
  "maxTaskLifetime": 7200
}
```

Every address is derived from a funded key in step 3, never an Anvil default account.
`agentManifests` needs one JSON string per member (role/provider/model/promptVersion/operator),
matching `local-5.json`'s pattern.

**Governance timings.** Base Sepolia blocks are about 2 seconds and the governor is
timestamp-clocked, so these values are in seconds. `votingDelay 60`, `votingPeriod 600`,
`timelockDelay 60`, `maxTaskLifetime 7200` (2 hours) is a reasonable starting point: long enough
for five model votes with retries, short enough to fit a one-hour pilot session comfortably.

**Deploy:**

```
fleet deploy --config deployments/configs/sepolia-5.json --rpc <RPC_HTTP_URL> \
  --key-env FLEET_DEPLOYER_KEY --out deployments/84532/latest.json
```

`--config`, `--rpc`, `--key-env` (default `FLEET_DEPLOYER_KEY`), and `--out` are exactly the
option names `fleet deploy --help` prints. This shells out to `forge script
script/DeployFleet.s.sol` and is idempotent: re-running it with an unchanged config and an
existing manifest at `--out` does nothing.

**Verify:**

```
fleet verify --manifest deployments/84532/latest.json --rpc <RPC_HTTP_URL>
```

This runs `VerifyDeployment.s.sol` and retries a few times on its own if the chain's clock has
not advanced past the deployment block yet.

**Standalone `open-task`.** `fleet open-task --manifest <path> --charter <path> --lifetime
<seconds> --operator-key-env <name> --rpc <url>` opens a task with the operator's key outside a
full `fleet run`. Its `--operator-key-env` default is `OPERATOR_KEY`, not `FLEET_OPERATOR_KEY`
(the name `fleet run` reads); pass `--operator-key-env FLEET_OPERATOR_KEY` explicitly to reuse
the same key variable everywhere.

## 5. Read side

Set these keys in `infra/.env` (see `infra/.env.sepolia.example` for the full file):

| Key | Sepolia value |
| --- | --- |
| `CHAIN_ID` | `84532` |
| `CONTRACT_DEPLOYMENT` | `sepolia` (a label used by the DAO Node/CPLS config templates) |
| `DAO_NODE_ARCHIVE_NODE_HTTP` | the RPC HTTP URL |
| `DAO_NODE_REALTIME_NODE_WS` | the RPC WSS URL |
| `ANVIL_RPC_URL` | the RPC HTTP URL (blockcache-shim proxies to whatever this points at) |
| `NEXT_PUBLIC_FORK_NODE_URL` | the RPC HTTP URL |
| `NUM_REALTIME_CLIENTS` | `1` (unchanged from local) |
| `NUM_POLLING_CLIENTS` | `1` (it is `0` only for local Anvil; a real chain needs the polling backstop for websocket events a provider drops) |
| `DAO_NODE_ARCHIVE_NODE_HTTP_BLOCK_COUNT_SPAN` | `2000` (pins the value against a provider that caps `eth_getLogs` lower) |
| `GOVERNOR_CLOCK_MODE` | `timestamp` (leave as is; AgoraGovernor V2 is timestamp-clocked on every chain) |
| `JWT_SECRET` | a fresh secret, `openssl rand -hex 32`. The literal in `.env.example` is published in this repository |
| `GCS_BUCKET_NAME` | the real bucket name from section 3 |
| `GCS_CREDENTIALS_FILE` | the service account JSON key path from section 3 |

`TOKEN_ADDRESS`, `GOVERNOR_ADDRESS`, and `DAO_NODE_START_BLOCK` are written for you by `fleet
readside`, not set by hand.

**Write the read side and restart it:**

```
fleet readside --manifest deployments/84532/latest.json --infra-dir infra --restart
```

`--manifest`, `--infra-dir` (default `infra`), and `--restart` are the exact option names from
`fleet readside --help`. This writes `infra/.env`'s `TOKEN_ADDRESS`/`GOVERNOR_ADDRESS`/
`DAO_NODE_START_BLOCK` (every other key untouched), copies the token and governor ABIs into
`infra/dao-node/abis/<lowercase address>.json`, writes
`deployments/agora-next-deployment.json`, and with `--restart` runs `docker compose ... up -d
--force-recreate dao-node cpls`, then waits on `http://localhost:<DAO_NODE_PORT>/v1/progress` and
`http://localhost:<CPLS_PORT>/health`.

**Restart matrix** (from `infra/README.md`), what to do after any redeploy:

| Service | After a redeploy |
| --- | --- |
| dao-node | needs `--force-recreate` (bakes addresses into container env at start) |
| cpls | needs `--force-recreate` (same reason) |
| blockcache-shim | nothing (only proxies to the chain) |
| agora-next | nothing once `deployments/agora-next-deployment.json` is rewritten; it re-reads that file per request |
| anvil | not applicable to Base Sepolia |
| postgres | nothing, unless a `postgres/init/*.sql` file changed, which needs `down -v` |

**Health checks** (default ports; adjust if you changed `infra/.env`'s port variables):

- `curl http://localhost:8000/v1/progress` (DAO Node)
- `curl http://localhost:8001/health` (CPLS)
- `open http://localhost:3000/proposals` (Agora Next)

If the bucket is not public-read, Agora Next's pages render HTTP 200 with no proposals, no
votes, and no error anywhere. Re-check the IAM binding from section 3 first if pages look empty.

## 6. First run

`fleet run` drives the full pipeline (spec 12.2): `PREFLIGHT -> CHAIN_READY -> DEPLOYED ->
VERIFIED -> INDEXERS_READY -> TASK_OPENED -> AGENTS_RUNNING -> TASK_ENDED -> CAPTURED ->
REPORTED`. Every stage checks chain or file state first, so it is resumable with `--run-id`.

**A path note.** `fleet run`'s own `DEPLOYED` stage deploys from
`deployments/configs/<experiment name>.deploy.json` (the experiment config's own `name` field,
not the path passed to `--experiment`) and always writes its manifest to the fixed path
`deployments/experiment-latest.json`, not `deployments/84532/latest.json`. To have `fleet run`
reuse the exact fleet deployed and verified in section 4 rather than deploying a second, separate
one: name the experiment `sepolia-5` and save the deploy config at
`deployments/configs/sepolia-5.deploy.json` with the same content as
`deployments/configs/sepolia-5.json`, then copy `deployments/84532/latest.json` to
`deployments/experiment-latest.json` before the first `fleet run` (its deploy stage skips
redeploying when the manifest already at that path has a matching config hash). Simpler for a
first pilot: skip the standalone deploy in section 4 and let `fleet run`'s own `DEPLOYED` stage do
the only deploy, then copy `deployments/experiment-latest.json` to `deployments/84532/<a
timestamp>.json` afterward for section 7's publishing step.

Create `experiments/configs/sepolia-hf-replay.json`, a `fleet.experiment.v1` config:

```json
{
  "schema": "fleet.experiment.v1",
  "name": "sepolia-5",
  "target": { "kind": "base-sepolia", "rpcHttp": "<RPC_HTTP_URL>", "rpcWs": "<RPC_WSS_URL>" },
  "fleet": {
    "members": [
      { "role": "planner", "provider": "scripted", "model": "scripted-v1", "promptVersion": "1", "operatorLabel": "sepolia" },
      { "role": "engineer", "provider": "scripted", "model": "scripted-v1", "promptVersion": "1", "operatorLabel": "sepolia" },
      { "role": "critic", "provider": "scripted", "model": "scripted-v1", "promptVersion": "1", "operatorLabel": "sepolia" },
      { "role": "budget", "provider": "scripted", "model": "scripted-v1", "promptVersion": "1", "operatorLabel": "sepolia" },
      { "role": "safety", "provider": "scripted", "model": "scripted-v1", "promptVersion": "1", "operatorLabel": "sepolia" }
    ],
    "tokenName": "Fleet Vote",
    "tokenSymbol": "FLEET"
  },
  "governance": { "votingDelay": 60, "votingPeriod": 600, "timelockDelay": 60, "quorumNumerator": 6000, "proposalThreshold": "1000000000000000000", "maxTaskLifetime": 7200 },
  "task": { "charter": { "...": "a fleet.charter.v1 object, inline, see experiments/fixtures/charters/coding-task.v1.json for an example" }, "lifetime": 7200, "repoFixture": "experiments/fixtures/repos/tiny-lib" },
  "scenario": { "fixture": "hf-replay", "agentsScripted": true },
  "capture": { "reportDir": "experiments/reports" },
  "display": { "agoraNextBaseUrl": "http://localhost:3000" }
}
```

`task.charter` is an inline `fleet.charter.v1` object, not a file path.

**Run the scripted smoke fixture first** (spec 16.2 step 3), before any model agent:

```
fleet run --experiment experiments/configs/sepolia-hf-replay.json --readside
```

`--experiment`, `--run-id`, `--report-dir`, and `--readside` are the exact option names from
`fleet run --help`. `--readside` brings up and syncs the Docker Compose read side as part of the
run; PREFLIGHT then also checks container health and the bucket, using the ports in `infra/.env`.

**Model-driven `hf-replay`: not available from `fleet run` yet.** As of this runbook, `fleet
run`'s `AGENTS_RUNNING` stage only loads fixtures from `experiments/fixtures/scripted/` and only
accepts the `fleet.fixture.v1` shape (`apps/runner/src/fixtures.ts`'s `loadFixture`); it rejects
`experiments/fixtures/model/hf-replay.json`'s `fleet.fixture.model.v1` shape outright. A
`fleet.experiment.v1` config's per-member `provider` field (`scripted`, `claude-cli`,
`openrouter`) is accepted by the schema but is never read anywhere in the current pipeline; only
`scripted` behavior runs, regardless of what `provider` names. `apps/worker`, the standalone agent
process, likewise only supports `FLEET_POLICY=scripted:<DIRECTIVE>` today. The model provider
adapters themselves exist (`@fleet/agent-runtime`'s `openrouter.ts` and `claude-cli.ts`), but
wiring them into a run is spec milestone M3 (Runner UI, model agents), a later task. Do not
attempt a model-driven Sepolia run until that wiring lands; re-run this section once it does, and
use `OPENROUTER_API_KEY` from the repo-root `.env` with the default model
`meta/muse-spark-1.3-contributor` (or a Claude model on OpenRouter) per agent.

## 7. Publishing the manifest and the Agora Next URL

Copy the manifest that `fleet run` actually deployed against (`deployments/experiment-latest.json`,
or `deployments/84532/latest.json` if you deployed by hand in section 4 and skipped the reuse
step) to a timestamped archive copy under `deployments/84532/`, matching the local convention
(`deployments/<chainId>/latest.json` plus a timestamped copy). Publish, alongside it: the chain
id (84532), the six contract addresses from the manifest, and the Agora Next URL you set in the
experiment config's `display.agoraNextBaseUrl` (used by `fleet report`'s rendered links). Anyone
with that URL and a public bucket can read the same archive Agora Next reads.

## 8. Pilot checklist (M4)

Spec 14, milestone M4 acceptance:

| Checklist item | How to satisfy it |
| --- | --- |
| Published deployment manifest | Section 7 |
| Public trace of a defeated deviation | `hf-replay` fixture, `Defeated` outcome |
| Public trace of a passed amendment | `legit-amendment` fixture, `Succeeded`, charter version 2 |
| Public trace of a visible delegation | `delegation-visible` fixture, delegates page shows concentration |
| Public trace of a rejected impostor | `impostor` fixture, both attempts revert and are shown in the Runner |
| Public trace of a guardian intervention | `guardian-cancel` fixture, canceled, nothing recorded |
| Measured results report with actual fee and inference costs | `fleet report --run-id <id>`; `record.json`'s `fees[]` and `metrics` |

Run each fixture at least once (spec 14 M4: "Run the fixture set of section 15.3 at least once
each"); the five above are the ones M4's acceptance line names explicitly. `fleet run` drives one
fixture per experiment config, named by `scenario.fixture`; run one experiment config per fixture,
changing only `name` and `scenario.fixture`.

## 9. Incident response (16.3)

On suspected signer compromise, an unsafe pending decision, or an integration bug:

| Step | Command |
| --- | --- |
| Pause the ledger | Runner UI's guardian controls (Task 5, not yet built) or `cast send <ledger-address> "pause()" --private-key $FLEET_GUARDIAN_KEY --rpc-url <RPC_HTTP_URL>` |
| Stop affected workers | stop the `apps/worker` / `apps/keeper` processes for the affected agents |
| Preserve records | keep `experiments/reports/<runId>/` and every bucket object; do not delete either |
| Cancel a queued timelock operation that must not survive an unpause | `cast send <timelock-address> "cancel(bytes32)" <operationId> --private-key $FLEET_GUARDIAN_KEY --rpc-url <RPC_HTTP_URL>` |

Do not rotate a member's key or lower the threshold to restore progress. Redeploy a new fleet
with a new manifest instead. A keeper outage delays recording, not decisions. Three missing
voters stop approvals. A paused ledger stops decisions. These are meant to fail closed.

## 10. Mainnet is out of scope

This runbook authorizes local and Base Sepolia work only (spec 16.4). No script in this
repository accepts `FLEET_ALLOW_MAINNET`: it appears only in `docs/spec.md`'s prose, never in any
source file, and `fleet.experiment.v1`'s `target.kind` accepts only `"local-anvil"` and
`"base-sepolia"`, no mainnet option. The Runner UI (Task 5) is expected to refuse chain id `8453`
outright once built. Moving to Base mainnet needs spec milestone M5 (a written mainnet readiness
review) first; nothing in M0 through M4 grants mainnet authority.

## 11. Known limitations

From `docs/compatibility-notes.md`, carried into any Sepolia deployment of this same stack:

- **DAO Node patches (`infra/dao-node/patches/0005`-`0007`).** Fleet Governance deploys no
  onchain proposal-type registry, so DAO Node's default `/v1/proposal_types` response and its
  missing `voting_module_name`/`start_block`/`end_block` handling need three patches for CPLS to
  sync a fleet proposal without crashing. These patches ship with the vendored fork; no action
  needed, just do not un-pin it.
- **The governor is timestamp-clocked.** AgoraGovernor V2 answers `CLOCK_MODE()` with
  `mode=timestamp`; `infra/blockcache-shim` needs `GOVERNOR_CLOCK_MODE=timestamp` (already the
  default in `infra/.env.example`) to resolve start/end times and contract calls correctly. Do
  not change this value.
- **CPLS patch (`infra/cpls/patches/0001`).** Without it, CPLS misencodes the proposal id when
  reading quorum and silently archives `quorum: "0"`, which makes every proposal appear to have
  met quorum in Agora Next's own status derivation. Ships with the vendored fork.
- **The For-only quorum rule is enforced in `FleetHook.beforeVoteSucceeded`,** not in
  `AgoraGovernor` itself: For must independently reach quorum and exceed Against; Abstain never
  counts toward passing.
- **Agora Next patch 0002.** Server-side archive reads go through `node:http`/`node:https`
  instead of `fetch()`, because this Next.js version's `fetch()` reliably threw reading a gzip
  response body server-side; every call site already treated that as "no data" silently. Ships
  with the vendored fork.
- **Model-driven agent runs are not wired into `fleet run` or `apps/worker` yet.** See section 6.
