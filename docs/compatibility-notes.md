# Compatibility notes

## Foundry image tag

`ghcr.io/foundry-rs/foundry:v1.7.1` exists and was pulled successfully
(digest `sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd`).
`infra/anvil/Dockerfile` uses that tag directly; no fallback to `:latest`
was needed.

## Agora Next Prisma web2/web3 split

`vendor/agora-next/src/app/lib/prisma.ts` exports `prismaWeb2Client` and
`prismaWeb3Client`, but both names are bound to the same `PrismaClient`
instance, built from a single `DATABASE_URL`:

```ts
const prismaWeb2Client = prismaClient;
const prismaWeb3Client = prismaClient;
```

`prisma/schema.prisma` also declares only one `datasource db` block with one
`schemas = [...]` list covering every tenant schema (`agora`, `config`,
`b3`, and the rest). There is no actual database split today; the two
exported names look like preparation for a future split that has not
happened.

Per the plan's fallback rule for this case, `infra/postgres/gen-stub.ts`
puts everything (the `fleet`-mapped `b3` views, plus the shared `agora` and
`config` tables) into `agora_web3`, and also writes the same `agora`/
`config` stub tables into `agora_web2` (`infra/postgres/init/03-agora-web2-stub.sql`),
so either connection string renders empty reads instead of failing on a
missing table.

## Postgres host port is 55432, not 5432

This machine (and any dev machine that already runs a local Postgres) may
have something bound to `127.0.0.1:5432`/`[::1]:5432` already: on this host
that's a Homebrew-managed `postgresql@16` service. To let this stack run
alongside that without touching it, `infra/docker-compose.yml` publishes the
`postgres` service's container port 5432 on host port `${POSTGRES_PORT:-55432}`
instead of 5432. The container's own Postgres still listens on 5432
internally (that's what `01-roles.sql`/`02-agora-stub.sql`/
`03-agora-web2-stub.sql` run against); only the host-side mapping moved.

Connect from the host with:

```
psql postgres://agora:agora@localhost:55432/agora_web3 -c '\dt fleet.*'
```

No need to stop a local Postgres service to verify this stack; a host
service already on 5432 is untouched and keeps running throughout.

## DAO Node (Task 3), pinned commit cb299a0

### `python:3.11-slim` has neither `envsubst` nor `curl`

The base image moved to Debian trixie. Confirmed with a throwaway
container (`docker run --rm python:3.11-slim bash -c "which envsubst; which curl"`):
both `which` calls report nothing. `envsubst` (needed by `entrypoint.sh` to
render `config.template.yaml`) comes from the `gettext-base` package, so
`infra/dao-node/Dockerfile` installs `git patch gettext-base` instead of
just `git patch`. There is no `curl` either, so the compose healthcheck
uses the Python interpreter already in the image:
`python3 -c "import urllib.request; urllib.request.urlopen(...)"`
(`urllib.request.urlopen` raises on a non-2xx status, which gives Docker a
nonzero exit code the same way `curl -sf` would).

### Routes at this commit do not all carry a `/v1` prefix

Only some of the routes have a `/v1` prefix; `/health`, `/config` and
`/deployment` do not (`app/server.py` lines 1791, 1820, 1826). Verified
with `curl -o /dev/null -w '%{http_code}'`: `GET /v1/config` and
`GET /v1/deployment` both return `404`; the real paths are `GET /config`
and `GET /deployment`. `GET /v1/progress`, `GET /v1/delegates`,
`GET /v1/balance/<addr>` and `GET /v1/proposals` do carry the `/v1`
prefix and work as expected. The compose healthcheck and Dockerfile
correctly target `/v1/progress` (confirmed routed, no `/health` fallback
needed).

Response shapes actually observed against a placeholder deployment
(`TOKEN_ADDRESS=0x...0001`, `GOVERNOR_ADDRESS=0x...0002`, empty chain):

```
GET /v1/progress
{
  "block": 51,
  "realtime_counts": {"31337.blocks.JsonRpcRtWsClient": 4},
  "archive_counts": {"31337.blocks.JsonRpcHistHttpClient": 1},
  "total_counts": {"31337.blocks": 5},
  "boot_time": "2026-09-14T05:31:46.692626",
  "worker_id": "20152216914780365",
  "git_commit_sha": "n/a",
  "delegations.voting_power_adj": 0
}

GET /config
{"config": {"governor_spec": {"name": "agora", "version": 2.0},
             "token_spec": {"name": "erc20", "version": "?"},
             "module_spec": null}}

GET /deployment
{"deployment": {"gov": {"address": "0x1000...0002"},
                 "token": {"address": "0x1000...0001", "decimals": 18},
                 "chain_id": 31337}}

GET /v1/delegates      -> {"delegates": []}
GET /v1/balance/<addr> -> {"balance": "0", "address": "<addr>"}
GET /v1/proposals      -> {"proposals": []}
GET /health             -> 500 {"status": "error",
                                 "message": "[Errno 2] No such file or directory: 'data'"}
```

`/health` 500s whenever `DAO_NODE_DATA_PATH` (default `./data`, unset in
this compose service) does not exist; it tries to `os.listdir()` it even
when no CSV archive is in use. Harmless (CSV archive is optional and we
don't provide one), but it means `/health` is not a safe healthcheck
target here even where the fallback in the brief mentions it. `/v1/progress`
does not have this problem, which is what the Dockerfile/compose already use.

### `abifsm`'s own module sets `ABI_URL` unconditionally on import

`abifsm/abifsm.py` (installed from `git+https://github.com/voteagora/abifsm@master`,
resolved to commit `cab5a70` at build time) does
`os.environ['ABI_URL'] = 'https://storage.googleapis.com/agora-abis/v2'`
at module scope, unconditionally, and this import happens before
`app/server.py`'s own (now `setdefault`) line runs. So `ABI_URL` cannot
actually be overridden via env unless something sets it after `abifsm` is
imported. This doesn't affect patch 0001's `load_abi()` helper, which
reads `ABI_DIR` directly and calls `ABI.from_file(...)`, bypassing
`ABI_URL` entirely when a local file exists. Noted here only because the
`setdefault` change alone would not have been sufficient to let an
operator override the internet fallback URL.

### `ENABLE_BALANCES` env parsing is effectively always true

`app/dev_modes.py`: `ENABLE_BALANCES = bool(os.getenv('ENABLE_BALANCES', True))`.
`os.getenv` returns a string when the var is set, and `bool()` of any
non-empty string is `True` (including `"false"` or `"0"`). So this flag
can only be turned off by setting `ENABLE_BALANCES=` (empty string).
Not something we touched; noted because it explains why `/v1/balance/<addr>`
was routed and reachable without any special config.

### `forge build` output is shared and was clobbered mid-task by other work

`contracts/` is not inside this task's worktree; it's the shared repo
checkout other task agents also use. Mid-verification, a second
`forge build` failed on unrelated, transient files
(`src/scratch_repro/Repro4.sol`, then `test/unit/FleetHook.t.sol`) that
belong to other in-flight work, and `contracts/out/` had been wiped
between runs. Both failures cleared on their own moments later
(confirmed via `git status --short` showing those paths as untracked and
then gone). Unrelated to dao-node; noted so a future task agent hitting a
transient `forge build` failure in this shared directory knows to retry
rather than assume the governor contracts are broken.

### `JsonRpcRtHttpClient.read()` (the polling client) blocks the event loop; mitigated by disabling it in compose

`app/clients_httpjson.py` `JsonRpcRtHttpClient.read()` (line ~506) is
declared `async def` but its body (`w3.eth.block_number`,
`get_paginated_logs(...)` -> `w3.eth.get_logs(...)`) is 100% synchronous
`web3.py` calls (the default `HTTPProvider` uses blocking `requests`
under the hood) with no `await` before the first `yield`. This is
pre-existing upstream behaviour, not something any of our four patches
touch.

With the full upstream default client mix (`NUM_REALTIME_CLIENTS=2`,
`NUM_POLLING_CLIENTS=1`), we saw the container hang completely on cold
start on 2 of 5 boots in the first verification pass: TCP connect
succeeded but every HTTP request timed out forever, including from
`docker exec` inside the container itself, and the healthcheck never
turned healthy. Isolation tests (varying `NUM_REALTIME_CLIENTS`/
`NUM_POLLING_CLIENTS` on ad hoc `docker run` containers against the same
anvil) showed the WS realtime client alone and the polling client alone
(whose first real poll only fires after `POLLING_WAIT_CYCLE`, default
120s) each boot and serve fine on their own; only the full default
combination reproduced the hang, and not on every boot. We believe this
is a race between the two realtime WS subscriptions and the synchronous
archive/polling reads against anvil's very low-latency, fast-block-time
(`--block-time 2`) local chain, a condition upstream almost certainly
never hits against a real mainnet/L2 RPC endpoint.

**Mitigation shipped (configuration, not a source patch):**
`infra/docker-compose.yml`'s `dao-node` service now sets
`NUM_REALTIME_CLIENTS: "1"` and `NUM_POLLING_CLIENTS: "0"`, and its
healthcheck gained `start_period: 30s`. One realtime websocket client is
enough to track new blocks on a local chain; the polling client is
upstream's own backup for missed websocket events (its docstring: "if
everything is working, none of the events caught in polling would ever
be needed"), so disabling it removes the only other client that was
ever observed hanging the loop, at no functional loss for this stack.
We did not patch `JsonRpcRtHttpClient.read()` itself (e.g. wrapping it in
`asyncio.to_thread`): the controller ruling was to mitigate by
configuration first, and five consecutive cold boots with this mitigation
all came up healthy (see results below), so a fifth patch was not needed.
If a source-level fix is wanted later regardless (e.g. because some other
deployment needs `NUM_POLLING_CLIENTS>0`), the fix is straightforward:
move the blocking `web3.py` calls in `read()` onto a thread with
`asyncio.to_thread` so they don't block the Sanic event loop.

Five consecutive cold boots with the mitigation in place
(`docker compose down dao-node && docker compose up -d dao-node`,
polling `docker inspect --format='{{.State.Health.Status}}'` up to a 90s
timeout per run):

| Run | Result    | Time to healthy |
|-----|-----------|------------------|
| 1   | healthy   | 7s               |
| 2   | healthy   | 7s               |
| 3   | healthy   | 7s               |
| 4   | healthy   | 7s               |
| 5   | healthy   | 7s               |

All five healthy, consistent ~7s each. Log for each boot showed exactly
one `Realtime client N started` line and no `Polling client` line at all,
confirming the env vars took effect.

If `dao-node` is ever still seen stuck at `health: starting` past its
healthcheck retries despite this, `docker compose restart dao-node`
remains a safe workaround while investigating further.

### Patch 0003 (`DAO_NODE_START_BLOCK`) verified through Compose itself, both directions, plus the empty-string bug fix

**Bug found in review and fixed:** the first version of this patch did
`start_block = os.getenv('DAO_NODE_START_BLOCK', None); if start_block is
not None: self.fallback_block = int(start_block)`. Compose renders an
*unset* `${DAO_NODE_START_BLOCK}` as an empty string rather than omitting
the env var entirely, so `os.getenv(...)` returned `''` (not `None`),
`'' is not None` was `True`, and `int('')` raised `ValueError`, crashing
the archive client instead of falling through to the block search. Fixed
to `start_block = os.getenv('DAO_NODE_START_BLOCK', '').strip(); if
start_block: try: ... except ValueError: log and fall through`, so blank/
whitespace is treated as unset and a garbage value is logged and ignored
rather than crashing. `infra/docker-compose.yml` also now spells out
`DAO_NODE_START_BLOCK: ${DAO_NODE_START_BLOCK:-}` so the rendered value
is explicit rather than implicit.

Verified via `docker compose config` (renders the `dao-node.environment`
block; ran once with `DAO_NODE_START_BLOCK` absent from `infra/.env`,
once with it set to `0`):

```
# infra/.env has no DAO_NODE_START_BLOCK line
$ docker compose config | grep DAO_NODE_START_BLOCK
      DAO_NODE_START_BLOCK: ""

# infra/.env has DAO_NODE_START_BLOCK=0
$ docker compose config | grep DAO_NODE_START_BLOCK
      DAO_NODE_START_BLOCK: "0"
```

Then verified with real boots through Compose (not just `docker run`):
with the var absent (rendering `""`) the container did **not** crash and
its log showed `Searching for a block ~7 days ago from block 5` then
`No block older than 7 days found.` before reading from block 0 (the old,
correct fallback behaviour, now reachable again since `int('')` no longer
raises); with `DAO_NODE_START_BLOCK=0` the log showed
`Reading from client #1 of type JsonRpcHistHttpClient from block 0`
immediately, no search. Also spot-checked two more cases directly against
the built image: a whitespace-only value (`"   "`) behaves exactly like
unset, and a non-numeric value (`"not-a-number"`) logs
`Ignoring invalid DAO_NODE_START_BLOCK='not-a-number'; falling back to
block search.` and then proceeds with the normal 7-day search, rather
than crashing.

### Patch 0002 (marker tolerance) verified with a temporary, non-shipped-differently unit test, then made permanent as patch 0004

Added `test_Proposals_agora_v2_missing_proposal_type_marker` to
`tests/test_data_products.py` (a fourth patch,
`infra/dao-node/patches/0004-test-proposal-type-marker-tolerance.patch`,
touching only that test file). Ran it inside the built image both before
and after patch 0002: unpatched, it fails with the exact upstream bug
(`IndexError: list index out of range` at
`app/data_products.py:875`); patched, it passes. Full existing suite
(`pytest tests/test_data_products.py`) also passes unchanged (25/25)
against the fully patched image. `tests/test_endpoints.py` has 6
pre-existing errors from a missing `sanic-testing` dev dependency and a
Sanic app-registry collision across its fixtures; confirmed identical on
both patched and unpatched trees, so not something we introduced (and
`requirements_dev.txt`, which has `sanic-testing`, is deliberately not
installed in the production image).

### `pip install -r requirements.txt` needed no compiler

Unlike upstream's own `Dockerfile` (which installs `build-essential`),
`infra/dao-node/Dockerfile` does not, and the build still succeeds:
every dependency (`cryptography`, `cffi`, `uvloop`, `httptools`, `ujson`,
etc.) had a matching manylinux wheel for the build host's architecture.
Worth re-checking if this image is ever built on an architecture without
prebuilt wheels for one of these packages.

### ABI export: `FleetVotes.sol/FleetVotes.json` used over `ERC20Votes.sol/ERC20Votes.json`

`forge build` produces both. `FleetVotes` is the deployable token
contract (51 ABI fragments, superset of the abstract `ERC20Votes` import
it extends, 44 fragments, plus a `registry` accessor), so it's the
correct one for a real token deployment and is what Task 6's script
should also prefer when both are present.

## CPLS and the archive store (Task 4), pinned commit be1ef85645b467008fb6028d6df9db4e6f39dc66

### Env var names, confirmed from source

`vendor/cpls/cpls/config.py`:
- `ENVIRONMENT` (line 10, default `dev`), `GCS_BUCKET_NAME` (line 13),
  `WRITE_TO_DISK = ENVIRONMENT == 'dev'` (line 21, not itself an env var).
- Tenant config directory is `TENANT_CONFIG_PATH` (line 22, singular
  "TENANT", not "TENANTS"), default `/config/envs/prod`. The module-level
  variable holding it is named `TENANTS_CONFIG_PATH` (plural) but the env
  var it reads is singular; easy to typo.
- `DEPLOYMENT` (line 23, default `main`) selects which key of a tenant
  YAML's `deployments:` map to use.
- `INFRA_DAO_SLUGS` (line 24, default
  `ens,optimism,cyber,pguild,syndicate`, comma-separated or `all`) is the
  list the scheduler iterates; we set it to `fleet` since only that tenant
  is provisioned.
- `DAO_NODE_URL_TEMPLATE` (line 29) is the exact env key, confirmed; the
  brief's guess was right.

`vendor/cpls/cpls/gcs.py`:
- `GCSClient.__init__` (line 16) defaults `local_copy_dir` to the
  hardcoded developer path `/home/developer/code/cpls/data`; this is a Python
  default, not read from any env var, so it can't be redirected without a
  source patch. We didn't patch it (out of scope, harmless): the path is
  created with `mkdir(parents=True)` inside the container and the debug
  copies just live in the container's writable overlay filesystem,
  discarded on removal. Confirmed populated:
  `docker exec infra-cpls-1 find /home/developer/code/cpls/data -type f` listed
  `jobs/scheduled/...json`, `jobs/sync_daonode/...json`,
  `data/fleet/proposal_list.full.ndjson.gz`, and
  `data/fleet/proposal_list/dao_node/raw.ndjson.gz`.
- Also noticed in passing (lines ~135-138 and ~245-248): the local debug
  copy is written as **uncompressed** text but saved under the
  **`.gz`-suffixed** filename (`_write_local_copy(blob_name, ...)` is
  called with the gzip blob name but plain-text bytes). Pre-existing
  upstream behaviour, not something we touched; worth knowing if anyone
  tries to `gunzip` one of these local debug files and gets "not in gzip
  format".
- Credentials: `GOOGLE_CREDENTIALS` (a JSON blob env var, line 28) if set,
  else plain `storage.Client()` (line 33), which resolves credentials via
  standard `google-auth` behaviour: `GOOGLE_APPLICATION_CREDENTIALS` (a
  file path) or metadata-server ADC. Neither `GOOGLE_APPLICATION_CREDENTIALS`
  nor `STORAGE_EMULATOR_HOST` are CPLS-specific; they're standard
  `google-cloud-storage` library env vars, and `vendor/cpls/DOCUMENTATION.md`'s
  own env var reference table (lines 862-880) doesn't mention either,
  confirming they're library-level, not application-level.

`vendor/cpls/cpls/sync_daonode.py`: `DAO_NODE_URL_TEMPLATE.format(tenant_namespace=self.infra_dao_slug)`
at lines 127, 134, 142, 151, fetching `/v1/progress`, `/v1/proposals`,
`/v1/proposal/{id}`, `/v1/proposal_types` respectively. Confirmed the
template does **not** need to contain `{tenant_namespace}`: Python's
`str.format()` silently ignores unused keyword arguments when the format
string has no matching placeholder (`'http://dao-node:8000'.format(tenant_namespace='fleet')`
returns `'http://dao-node:8000'` unchanged). `DAO_NODE_URL_TEMPLATE=http://dao-node:8000`
works fine as a single-DAO-Node stack, no placeholder required.

### STORAGE_EMULATOR_HOST really does bypass ADC, verified empirically against the built image

Ran directly against the pinned `google-cloud-storage==2.18.2` (from
`vendor/cpls/requirements.txt`) inside the built `infra-cpls` image:

```
$ docker run --rm --entrypoint python3 -e STORAGE_EMULATOR_HOST=http://fake-gcs:4443 infra-cpls -c "
from google.cloud import storage
c = storage.Client()
print('credentials type:', type(c._credentials))
print('base_url:', c._connection.API_BASE_URL)
"
credentials type: <class 'google.auth.credentials.AnonymousCredentials'>
base_url: http://fake-gcs:4443
```

So when `STORAGE_EMULATOR_HOST` is set, `storage.Client()` swaps in
`AnonymousCredentials` and never calls `google.auth.default()` at all,
meaning the `GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcs.json` bind mount
(defaulted to `/dev/null`, an empty file) is never actually read or
parsed while pointed at the emulator. Confirmed the failure mode too: a
bare `docker run` with no env vars at all crashed at
`storage.Client()` with `google.auth.exceptions.DefaultCredentialsError`,
and because `gcs_client = GCSClient(GCS_BUCKET_NAME)` is instantiated at
**module import time** in `cpls/server.py` (line 32, outside any
try/except. Only the later `self.bucket = self.client.bucket(...)` call
in `gcs.py` is wrapped, so that exception propagates all the way up through
`uvicorn`'s app import and kills the whole container before it ever binds
a port. This is why `STORAGE_EMULATOR_HOST` has to default to something
usable rather than being left unset by default.

### `STORAGE_EMULATOR_HOST` couldn't be scoped strictly to the `offline` compose profile

The brief's framing was "under the `offline` profile, also
`STORAGE_EMULATOR_HOST=http://fake-gcs:4443`", implying it should only
apply when `--profile offline` is active. Compose profiles gate whether a
*service* starts, not individual env vars within one always-on service
definition, and there's no conditional syntax to add one env var to
`cpls` only when a given profile is requested. Given the crash mode
above, leaving `STORAGE_EMULATOR_HOST` unset by default was not an
option (it would crash-loop `docker compose up` with no profile and no
real credentials configured). Instead, `infra/docker-compose.yml`'s
`cpls` service defaults it to the fake-gcs address via
`${STORAGE_EMULATOR_HOST:-http://fake-gcs:4443}` and documents the
override in `infra/.env.example`. To use real GCS: set
`STORAGE_EMULATOR_HOST=` (blank) and `GCS_CREDENTIALS_FILE=/path/to/real-key.json`
in `infra/.env`, set `GCS_BUCKET_NAME` to the real bucket, and run
`docker compose up` **without** `--profile offline` (fake-gcs then never
starts, which is fine since nothing points at it once
`STORAGE_EMULATOR_HOST` is blank).

### No literal `sync_daonode` job type exists in `cpls/jobs.py`; `job.type` is a free-form label

The brief (and `vendor/cpls/DOCUMENTATION.md`'s own example payload) both
suggest posting a job of `"type": "sync_daonode"`, but grepping the
source (`grep -rn "sync_daonode\b" cpls/*.py`) finds no job-type constant
or dispatch branch keyed on that string anywhere. `JobQueue._execute_job`
(`cpls/jobs.py` lines ~366-419) does not branch on `job.type` at all; it
iterates `job.payload['sources']` and dispatches by **source name**
(`'dao_node'`, `'eas-atlas'`, `'eas-oodao'`, `'snapshot'`), driven
entirely by payload fields:
- `infra_dao_slug` (required; `JobQueue.add_job`, line ~124-126, raises
  `ValueError` if missing)
- `sources`: a list, e.g. `["dao_node"]` (required; `KeyError` if absent)
- `logic`: must be the literal string `"refresh_list"` for any sync to
  actually run (required key, but only `"refresh_list"` does anything;
  any other value silently produces zeroed stats)
- `config`: the **full tenant config dict** as produced by
  `load_tenant_configs()`, not just a tenant slug string (required key)
- `reset`: boolean (required key)

`job.type` (`POST /jobs`'s `"type"` field) is stored on the `Job` record
and used only to namespace the GCS job-result path
(`jobs/{job.type}/{timestamp}_{job.id}.json`, `cpls/gcs.py` lines
319-321) and the `GET /jobs/{id}` response's `type` field; it has zero
effect on execution. Production code (`cpls/server.py`'s
`scheduled_proposal_job`, lines 57-58) uses `job_type="scheduled"`, not
`"sync_daonode"`. We still posted `"type": "sync_daonode"` in the manual
verification job below, since the brief asked for it by that name and it
is a valid (if cosmetic) choice for the label. Confirmed it round-trips
correctly (`GET /jobs/{id}` returned `"type":"sync_daonode"`, and the
result landed at `jobs/sync_daonode/...json` in the bucket) with no
functional difference from `"scheduled"`.

Exact working payload (see also "Verify a job writes the archive" below):

```json
{
  "type": "sync_daonode",
  "payload": {
    "infra_dao_slug": "fleet",
    "logic": "refresh_list",
    "sources": ["dao_node"],
    "config": {
      "schema": "fleet",
      "dao_slug": "FLEET",
      "index_tenant_prefix": "fleet",
      "features": {"oodao": false, "snapshot_proposals": false, "dao_node_proposals": true},
      "deployment": {
        "chain_id": 31337,
        "gov": {"address": "0x1000000000000000000000000000000000000002"},
        "token": {"address": "0x1000000000000000000000000000000000000001"}
      }
    },
    "reset": true
  }
}
```

### `reset: true` (or `RESET_PROPOSALS_ON_RESTART`'s first-run default) is required to get any output at all with zero proposals

`DaoNodeSync.refresh_list` (`cpls/sync_daonode.py`, end of method) only
calls `refresh_source_list`/`refresh_full_list` (the calls that actually
write `proposal_list/{source}/raw.ndjson.gz` and
`proposal_list.full.ndjson.gz`) `if anything_changed or self.reset`.
`anything_changed` is initialized `False` and is never set anywhere in
the method when the proposals loop body never executes (which is exactly
what happens with dao-node's placeholder-address, zero-proposal chain).
So a job with `"reset": false` against an empty DAO produces **no**
archive objects at all, only the `jobs/{type}/...json` result record.

This did not block verification because `RESET_PROPOSALS_ON_RESTART`
defaults to `true` (`cpls/config.py` line 26) and
`reset_tracker = defaultdict(lambda: RESET_PROPOSALS_ON_RESTART)`
(`cpls/server.py` line 27) means the **first** scheduled job for a given
`infra_dao_slug` after container start always runs with `reset=True`
(then flips to `False` for subsequent runs, `cpls/server.py` line 71).
With `SCHEDULER_INTERVAL_MINUTES=1`, this fired automatically about a
minute after boot and produced the expected objects without any manual
job post. For the manual `POST /jobs` verification we set
`"reset": true` explicitly so the result wouldn't depend on scheduler
timing.

### Health route and job dispatch confirmed

`GET /health` (`cpls/server.py` lines 205-213) returns
`{"status": "healthy", "queue_size": ..., "total_jobs": ..., "current_job": ...}`
unconditionally (no error branch), unlike dao-node's `/health` (see
above). `infra/docker-compose.yml`'s `cpls` healthcheck targets it
directly, same `python3 -c "import urllib.request; ..."` pattern as
dao-node's healthcheck (python:3.11-slim has no `curl`).

### Object names actually produced (verified against fake-gcs, zero proposals)

```
data/fleet/proposal_list/dao_node/raw.ndjson        (uncompressed sibling, 0 bytes; ENVIRONMENT=dev writes both)
data/fleet/proposal_list/dao_node/raw.ndjson.gz      (20 bytes: gzip of an empty string)
data/fleet/proposal_list.full.ndjson                 (0 bytes)
data/fleet/proposal_list.full.ndjson.gz               (20 bytes)
jobs/scheduled/<timestamp>_<job-id>.json              (job result record, job_type="scheduled")
jobs/sync_daonode/<timestamp>_<job-id>.json            (job result record, job_type="sync_daonode")
```

The `.ndjson` (uncompressed) sibling alongside every `.ndjson.gz` is
`cpls/gcs.py`'s own behaviour: `must_upload_uncompressed = blob_name.endswith('.ndjson') or (ENVIRONMENT == "dev")`
(line 213), so in `dev` mode every upload gets both forms regardless of
the blob name passed in.

### CPLS's own tenant config: no private `tenants` repo, rendered from a template like dao-node's

`vendor/cpls/Dockerfile`'s upstream `CMD` is confirmed as
`python -m uvicorn cpls.server:app --host 0.0.0.0 --port 8001`
(`infra/cpls/entrypoint.sh` execs this exactly). But that Dockerfile also
`git clone`s a **private** `github.com/voteagora/tenants.git` repo into
`/config` using a `GITHUB_TOKEN` build arg we don't have and shouldn't
need for a local fleet-only stack. `vendor/cpls/DOCUMENTATION.md`'s
"Expected Tenant Config Structure" (lines 480-503) and
`cpls/config.py`'s `load_tenant_configs()` (lines 76-107) together give
the exact shape needed: a YAML file per tenant, keyed by filename stem,
with `schema`, `dao_slug`, `index_tenant_prefix`, `features`, and a
`deployments:` map keyed by deployment name with `chain_id`,
`gov.address`, `token.address`. `infra/cpls/tenants/fleet.yaml.template`
supplies this for `fleet` (`dao_slug: FLEET`, `index_tenant_prefix: fleet`,
`schema: fleet`), and `infra/cpls/entrypoint.sh` renders it with
`envsubst` into `$TENANT_CONFIG_PATH` (`/tenants`), the same pattern
`infra/dao-node/entrypoint.sh` already uses for
`config.template.yaml`. Compose sets `TENANT_CONFIG_PATH=/tenants`
(overriding the upstream default `/config/envs/prod`) and
`CONTRACT_DEPLOYMENT`/`DEPLOYMENT` to the same value dao-node uses, so
the template's `deployments.<CONTRACT_DEPLOYMENT>:` key and CPLS's own
`DEPLOYMENT` selector agree.

### Blocking dao-node regression found and worked around: fake token/gov addresses have no ABI anywhere

Bringing the full stack up under `--profile offline` failed before CPLS
was even reachable: `dao-node` crashed on every boot (container exited
1, `docker compose ps` showed `Error dependency dao-node failed to
start`). `infra/.env` (gitignored, not `.env.example`) had
`TOKEN_ADDRESS=0x1000000000000000000000000000000000000001` and
`GOVERNOR_ADDRESS=0x1000000000000000000000000000000000000002` left over
from Task 3's own verification (matching the addresses recorded in this
file's dao-node section above). `infra/dao-node/abis/` (the `ABI_DIR`
bind mount) held only `.gitkeep`, no file for either address, so patch
0001's `load_abi()` (`vendor/dao-node/app/server.py`, patched, lines
~1608-1636) fell through to `ABI.from_internet(...)` for the token
address during `bootstrap_data_feeds`, and that 404s:

```
docker logs infra-dao-node-1
...
ERROR: ABI not found for 0x1000000000000000000000000000000000000001 @
https://storage.googleapis.com/agora-abis/v2/31337/checked/0x1000...0001.json?t=...
Error: Expecting value: line 1 column 1 (char 0)
...
Main ERROR: Not all workers acknowledged a successful startup. Shutting down.
```

Confirmed this is a real, deterministic 404 (not a sandboxing artifact):
`docker run --rm curlimages/curl:latest -s -o /dev/null -w '%{http_code}\n' https://storage.googleapis.com/agora-abis/v2/31337/checked/0x1000000000000000000000000000000000000001.json`
returned `404`, and containers do have normal internet egress (the image
pull for that test succeeded). The all-zero placeholder
(`0x0000...0000`, `.env.example`'s own default) 404s identically, so
switching back to it would not have helped. This crash happens
unconditionally for **any** address without a real, published ABI or a
local `ABI_DIR` override, and it blocks every dao-node endpoint (not
just `/v1/proposals`), which in turn blocks `cpls`'s own boot healthcheck
and any DAO Node sync job.

Worked around locally by adding two placeholder ABI files to
`infra/dao-node/abis/` (`0x1000000000000000000000000000000000000001.json`
and `...0002.json`, each just `[]`, an empty ABI fragment list). This is
exactly the mechanism patch 0001 was written to support: a local
`ABI_DIR/<address>.json` file short-circuits the internet fetch
entirely. An empty ABI fragment list is safe here because these two
placeholder addresses are not real deployed contracts on the local anvil
chain, so no log ever needs decoding against them.
`docker compose up -d dao-node` came up healthy on the next attempt
(`starting` to `healthy` in about 9s) with these files present.

Not committed: `infra/dao-node/.gitignore` deliberately excludes
`abis/*.json` (Task 3's own choice, since real ABIs are meant to come
from Task 6's deploy script copying `contracts/out/`), so these two
placeholder files stay local to this worktree only and are not part of
this task's commit. A fresh clone or worktree will hit the same crash
against these fake addresses until either Task 6 actually deploys (which
populates real ABIs) or someone recreates the same two placeholder files
by hand:

```
echo '[]' > infra/dao-node/abis/0x1000000000000000000000000000000000000001.json
echo '[]' > infra/dao-node/abis/0x1000000000000000000000000000000000000002.json
```

This is flagged as a concern in the task report rather than fixed at the
source, since `dao-node/abis`'s population strategy belongs to Task 3/6,
not this task.

### Verification commands and outputs

```
$ cd infra && docker compose --profile offline up -d --build
...
 Container infra-dao-node-1 Error dependency dao-node failed to start   # see ABI blocker above
$ # added infra/dao-node/abis/0x1000...0001.json and ...0002.json ([])
$ docker compose up -d dao-node
 Container infra-dao-node-1 Healthy   (3rd health poll, ~9s)
$ docker compose up -d cpls fake-gcs
 Container infra-cpls-1 Healthy       (2nd health poll, ~9s)
$ docker compose ps
NAME               STATUS
infra-anvil-1      Up (healthy)
infra-cpls-1       Up (healthy)
infra-dao-node-1   Up (healthy)
infra-fake-gcs-1   Up
infra-postgres-1   Up (healthy)

$ curl -s http://localhost:8000/v1/proposals
{"proposals":[]}

$ ./infra/scripts/create-fake-bucket.sh
create-fake-bucket: created bucket fleet-archive-dev
$ ./infra/scripts/create-fake-bucket.sh        # idempotency check
create-fake-bucket: bucket fleet-archive-dev already exists, continuing

# Scheduler fired automatically ~1 min after cpls boot (SCHEDULER_INTERVAL_MINUTES=1,
# RESET_PROPOSALS_ON_RESTART default true on first run for the "fleet" tenant):
"Added scheduled job: bfc40cea-... for infra_dao_slug: fleet w/ sources: ['dao_node'] @ interval: 1 minutes)"
"Refreshed 0 proposals, skipped 0"

$ curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o" | jq '.items[].name'
"data/fleet/proposal_list.full.ndjson"
"data/fleet/proposal_list.full.ndjson.gz"
"data/fleet/proposal_list/dao_node/raw.ndjson"
"data/fleet/proposal_list/dao_node/raw.ndjson.gz"
"jobs/scheduled/20260914_060135_bfc40cea-6875-492e-9f95-1586dedab74c.json"

# Manual POST per the brief's Step 3, with the full corrected payload (see above):
$ curl -s -X POST localhost:8001/jobs -H 'content-type: application/json' -d @sync-daonode-job.json
{"job_id":"1311da54-b4fb-439c-932a-f14a6f22ba8b","status":"queued"}
$ curl -s http://localhost:8001/jobs/1311da54-b4fb-439c-932a-f14a6f22ba8b
{"id":"1311da54-...","type":"sync_daonode","status":"completed","error":null,...}
$ curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o" | jq '.items[].name'
...
"jobs/sync_daonode/20260914_060212_1311da54-b4fb-439c-932a-f14a6f22ba8b.json"   # new

$ curl -s ".../download/storage/v1/b/fleet-archive-dev/o/data%2Ffleet%2Fproposal_list%2Fdao_node%2Fraw.ndjson.gz?alt=media" | gunzip -c | wc -c
0   # confirmed: empty NDJSON list, gzip-compressed

$ curl -s http://localhost:8001/health
{"status":"healthy","queue_size":0,"total_jobs":3,"current_job":"..."}
```

### Switching to real GCS

Set in `infra/.env`:
- `GCS_CREDENTIALS_FILE=/absolute/path/to/service-account.json` (a real
  service-account key with write access to the target bucket)
- `GCS_BUCKET_NAME=<real-bucket-name>`
- `STORAGE_EMULATOR_HOST=` (blank; overrides the fake-gcs default)

Then run `docker compose up` **without** `--profile offline` (fake-gcs
then never starts). No source or Dockerfile change needed; `cpls/gcs.py`
already falls through to plain `storage.Client()` reading
`GOOGLE_APPLICATION_CREDENTIALS` (which compose sets to
`/secrets/gcs.json`, the bind-mount target of `GCS_CREDENTIALS_FILE`)
whenever `STORAGE_EMULATOR_HOST` is unset.
