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

### `STORAGE_EMULATOR_HOST`: moved from a profile-gated default to a separate overlay file (fix round 1)

The first pass of this task set `STORAGE_EMULATOR_HOST` on `cpls` with a
compose-level default, `${STORAGE_EMULATOR_HOST:-http://fake-gcs:4443}`,
reasoning that Compose profiles gate whether a *service* starts, not
individual env vars within one always-on service, so there's no
conditional syntax to add one env var to `cpls` only when a profile is
requested, and the crash mode above (see previous section) ruled out
leaving it unset by default. Code review correctly flagged this as wrong
regardless: it meant `STORAGE_EMULATOR_HOST` was set even on a plain
`docker compose up` with no profile requested at all, so a real-GCS run
had to explicitly override it, and the `${VAR:-default}` form makes an
empty override (`STORAGE_EMULATOR_HOST=`) impossible to distinguish from
"unset, use the default" (both render as the fake-gcs URL).

Fixed per controller ruling by switching from a profile to a **second
compose file used as an overlay**, which Compose merges on top of the
base file rather than gating a single service's fields conditionally:
- `infra/docker-compose.yml` (base) now describes the real-GCS
  configuration: no `STORAGE_EMULATOR_HOST` anywhere, and no `fake-gcs`
  service. `cpls`'s `GOOGLE_APPLICATION_CREDENTIALS`/`GCS_CREDENTIALS_FILE`
  wiring is unchanged. Booting the base file alone without real
  credentials configured now fails cpls's healthcheck (expected; there's
  no local fallback in this file), rather than silently defaulting to an
  emulator.
- `infra/docker-compose.offline.yml` (new) adds the `fake-gcs` service
  (moved here verbatim, `profiles:` key dropped since it's no longer
  needed) and an override for `cpls` that adds
  `STORAGE_EMULATOR_HOST: http://fake-gcs:4443` (a fixed value now, not
  env-driven) and `depends_on.fake-gcs: condition: service_started`
  (`fake-gcs` has no healthcheck, so `service_started` is the strongest
  available condition).
- Local/offline runs now use two `-f` flags:
  `docker compose -f infra/docker-compose.yml -f infra/docker-compose.offline.yml up -d`.
  Compose merges the two files' `services.cpls` maps key by key
  (confirmed below), so the override only needs to state the two keys
  that actually change; everything else from the base `cpls` definition
  (ports, the rest of `environment`, `volumes`, `healthcheck`,
  `depends_on.dao-node`) passes through untouched.

Verified both renders with `docker compose ... config`:

```
$ docker compose -f docker-compose.yml config | grep -n "^  cpls:\|^  fake-gcs:\|STORAGE_EMULATOR_HOST"
24:  cpls:
# (no fake-gcs, no STORAGE_EMULATOR_HOST anywhere in the output)

$ docker compose -f docker-compose.yml -f docker-compose.offline.yml config | grep -n "^  cpls:\|^  fake-gcs:\|STORAGE_EMULATOR_HOST"
24:  cpls:
46:      STORAGE_EMULATOR_HOST: http://fake-gcs:4443
114:  fake-gcs:
```

And confirmed the `depends_on` maps merge by service name rather than
one file's `depends_on` replacing the other's: the two-file render's
`cpls.depends_on` has **both** `dao-node: {condition: service_healthy}`
(from the base file) and `fake-gcs: {condition: service_started}` (from
the overlay).

To use real GCS: set `GCS_CREDENTIALS_FILE=/path/to/real-key.json` and
`GCS_BUCKET_NAME` to the real bucket in `infra/.env`, and run
`docker compose up` (base file only, no `-f infra/docker-compose.offline.yml`).
`STORAGE_EMULATOR_HOST` no longer exists as an env var to override at
all; it's simply absent from the real-GCS path now.

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

Bringing the full stack up (this was discovered before the overlay file
existed, back when local/offline mode was still a compose profile)
failed before CPLS was even reachable: `dao-node` crashed on every boot
(container exited 1, `docker compose ps` showed `Error dependency
dao-node failed to start`). `infra/.env` (gitignored, not `.env.example`)
had
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

### Verification commands and outputs (initial pass, superseded below)

This transcript is from before the fix-round-1 change from a compose
profile to `infra/docker-compose.offline.yml` (see above), kept as an
accurate historical record; the commands below use the profile syntax
that no longer exists. See "Verification commands and outputs (fix round
1: overlay)" further down for the current, working commands.

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

### Verification commands and outputs (fix round 1: overlay)

Re-ran the same end-to-end check after switching from the compose
profile to `infra/docker-compose.offline.yml`, from a clean state (no
containers running). The two local, gitignored ABI placeholder files
from the earlier dao-node blocker were still present on disk, so
dao-node came up healthy on the very first attempt this time:

```
$ docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d --build
...
 Container infra-anvil-1 Healthy
 Container infra-dao-node-1 Healthy
 Container infra-cpls-1 Starting
 Container infra-cpls-1 Started
$ docker compose -f docker-compose.yml -f docker-compose.offline.yml ps
NAME               STATUS
infra-anvil-1      Up (healthy)
infra-cpls-1       Up (healthy)
infra-dao-node-1   Up (healthy)
infra-fake-gcs-1   Up
infra-postgres-1   Up (healthy)

$ ./scripts/create-fake-bucket.sh
create-fake-bucket: created bucket fleet-archive-dev

$ curl -s -X POST localhost:8001/jobs -H 'content-type: application/json' -d @sync-daonode-job.json
{"job_id":"86c5da1c-64d5-4733-8aea-81044e4df805","status":"queued"}
$ curl -s http://localhost:8001/jobs/86c5da1c-64d5-4733-8aea-81044e4df805
{"id":"86c5da1c-...","type":"sync_daonode","status":"completed","error":null,...}

$ curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o" | python3 -c "import json,sys; [print(i['name'], i['size']) for i in json.load(sys.stdin)['items']]"
data/fleet/proposal_list.full.ndjson 0
data/fleet/proposal_list.full.ndjson.gz 20
data/fleet/proposal_list/dao_node/raw.ndjson 0
data/fleet/proposal_list/dao_node/raw.ndjson.gz 20
jobs/sync_daonode/20260914_061638_86c5da1c-64d5-4733-8aea-81044e4df805.json 881

$ docker compose -f docker-compose.yml -f docker-compose.offline.yml down
 ...all containers and the network removed cleanly...
```

Same object set as the initial pass (minus the scheduler's own
`jobs/scheduled/...` record, since this run was torn down before the
1-minute scheduler interval elapsed), confirming the overlay produces
identical archive behavior to the old profile-based setup, just without
`STORAGE_EMULATOR_HOST` leaking into the real-GCS (base-file-only) path.

### Switching to real GCS

Set in `infra/.env`:
- `GCS_CREDENTIALS_FILE=/absolute/path/to/service-account.json` (a real
  service-account key with write access to the target bucket)
- `GCS_BUCKET_NAME=<real-bucket-name>`

Then run `docker compose up` (base file only, no
`-f infra/docker-compose.offline.yml`); there is no `STORAGE_EMULATOR_HOST`
to unset anymore since fix round 1, it simply isn't part of the base
file's `cpls` environment. No source or Dockerfile change needed; `cpls/gcs.py`
already falls through to plain `storage.Client()` reading
`GOOGLE_APPLICATION_CREDENTIALS` (which compose sets to
`/secrets/gcs.json`, the bind-mount target of `GCS_CREDENTIALS_FILE`)
whenever `STORAGE_EMULATOR_HOST` is unset.

## Agora Next fleet tenant (Task 5), vendor pinned commit a9909c796ccb3d6fafb63a199d82c9d4af9ee48d

### Step 1: exact edit points (line numbers in the pristine vendor tree)

Recorded before editing, per the brief's Step 1.

- `src/lib/constants.ts`: `TENANT_NAMESPACES` object opens at line 45,
  closes at line 66; `SHAPE: "shape",` (the arm to add `FLEET: "fleet",`
  after) is line 65. `DELEGATION_MODEL` enum at line 39. `GOVERNOR_TYPE`
  enum at line 188. `TIMELOCK_TYPE` enum at line 200.
- `src/lib/tenant/tenantSlugFactory.ts`: the `SHAPE` arm (`"SHAPE" as any`)
  is lines 46-47, immediately before the `default:` throw. This file is
  short (52 lines total); every arm follows the same two-line shape.
- `src/lib/tenant/tenantContractFactory.ts`: `shapeTenantConfig` import at
  line 22; its `case`/`return` arm at lines 69-70, immediately before
  `default:`.
- `src/lib/tenant/tenantUIFactory.ts`: `shapeTenantUIConfig` import at line
  22; its `case`/`return` arm at lines 83-84 (this file blank-lines
  between arms, unlike the others).
- `src/lib/tenant/tenantTokenFactory.ts`: `SHAPE` arm starts at line 173,
  immediately before `default:`.
- `src/lib/tenant/tenant.ts`: `BRAND_NAME_MAPPINGS` object at lines 14-22
  (`shape: "Structura",` is the last entry, line 21).
- `src/lib/prismaUtils.ts`: 16 `switch (namespace)` statements, each with
  a `case TENANT_NAMESPACES.B3:` arm right before the fleet-equivalent
  needs to go, at lines 21, 83, 142, 201, 309, 367, 423, 489, 548, 600,
  658, 719, 771, 829, 890, 949 (matches the brief's "about sixteen"
  exactly). Every B3 arm has the shape
  `return prismaWeb3Client.b3<Model>.<method>(<args>)`; the fleet arm is
  the same call with `b3` swapped for `fleet` and namespace swapped for
  `FLEET`, verified line-for-line against a scripted transform (see
  "prismaUtils.ts: scripted, not hand-typed" below).
- `src/lib/proposals/status/standard.ts`: `calculateQuorumNumber` switch
  at lines 69-91 (function), `UNISWAP` arm at line 77 returning
  `forVotes`; `calculateQuorumBigInt` switch at lines 96-111, `UNISWAP`
  arm at line 98, same `forVotes` return. Fleet reuses the UNISWAP arm's
  `forVotes` (For-only) rule in both.
- `src/lib/proposalUtils.ts` (not `src/lib/proposalUtils/proposalStatus.ts`
  as the brief guessed; that file only imports `getProposalCurrentQuorum`
  from here): `getProposalCurrentQuorum` at lines 1107-1139, `UNISWAP` arm
  at lines 1119-1120 (`return BigInt(proposalResults.for);`). Same
  For-only rule.
- `prisma/schema.prisma`: `datasource db` block at lines 7-11, `schemas =
  [...]` list at line 10 (append `"fleet"`). The `b3*` views (`view
  b3AdvancedDelegatees` through `view b3VotingPowerSnaps`, 14 views) span
  lines 5219-5416, each `@@map("...")`-ed to a physical table name and
  `@@schema("b3")`-ed. `enum DaoSlug` at lines 6072-6098 (`config` schema;
  fleet does NOT get added here, see "DaoSlug: FLEET stays out of the
  Prisma-side enum" below).
- `src/lib/tenant/configs/contracts/b3.ts` and
  `src/lib/tenant/configs/ui/b3.ts`: read whole (85 and ~270 lines
  respectively), the template for `overlay/src/lib/tenant/configs/{contracts,ui}/fleet.ts`.

### prismaUtils.ts: scripted, not hand-typed

All 16 B3-to-fleet arms in `src/lib/prismaUtils.ts` were inserted by a
small Python regex transform (matched each `case
TENANT_NAMESPACES.B3:\n  return prismaWeb3Client.b3<X>.<method>(<args>);`
block and inserted an identical block right after it with `b3`->`fleet`
in the model reference and `B3`->`FLEET` in the case label), not typed by
hand across 16 near-identical spots. `git -C vendor/agora-next diff --
src/lib/prismaUtils.ts` after the transform showed exactly 16 insertions,
one per switch, each a 2-line `case`/`return` pair matching the file's
existing style. Verified by grepping `case TENANT_NAMESPACES.FLEET:`
count (16) against `case TENANT_NAMESPACES.B3:` count (16, unchanged) in
the patched file.

### DaoSlug: FLEET stays out of the Prisma-side enum, matches TOWNS/SYNDICATE/SHAPE

`prisma/schema.prisma`'s `enum DaoSlug` (config schema) already contains
`TOWNS`, `SYNDICATE`, and `SHAPE` as real members, yet
`tenantSlugFactory.ts` still returns them via `"TOWNS" as any` etc. rather
than a plain `DaoSlug` value. The reason isn't semver-relevant docs, it's
practical: the brief and controller notes both direct fleet to use the
same `"FLEET" as any` escape hatch, and `infra/postgres/gen-stub.ts`
already (from Task 2, unmodified by Task 5) does
`const daoSlugValues = [...extractEnumValues(text, "DaoSlug"), "FLEET"]`
i.e. it appends `"FLEET"` to the generated Postgres enum's label list
even though `"FLEET"` is absent from the Prisma schema text. So the
physical Postgres type `"config"."dao_slug"` does carry a `'FLEET'` label
(needed for raw SQL and `@db.dao_slug`-typed columns to accept fleet's
rows), but the generated TypeScript `DaoSlug` union type does not, hence
the `as any` cast. Patch 0001 does NOT touch `enum DaoSlug` in
`schema.prisma`; only `datasource.schemas` gets `"fleet"` appended (Step
4 of the brief, confirmed as the only schema.prisma edit needed).

### Timelock type: TIMELOCKCONTROLLER_WITH_ACCESS_CONTROL_ERC721_ERC115, not TIMELOCK_NO_ACCESS_CONTROL

The brief's own Step 2 example code used
`TIMELOCK_TYPE.TIMELOCK_NO_ACCESS_CONTROL`, but the controller notes
correctly flagged this as needing verification against the real
contracts. Checked `contracts/src/deploy/FleetDeployer.sol` (main tree,
read-only, lines 57-84): fleet's timelock is a genuine OpenZeppelin
`TimelockController` (`import {TimelockController} from
"@openzeppelin/contracts/governance/TimelockController.sol"`), with
`PROPOSER_ROLE`/`EXECUTOR_ROLE`/`CANCELLER_ROLE` explicitly granted to the
governor and `DEFAULT_ADMIN_ROLE` renounced from the deployer after setup
- real AccessControl-gated roles, not a plain executor. That is exactly
what `TIMELOCK_TYPE.TIMELOCKCONTROLLER_WITH_ACCESS_CONTROL_ERC721_ERC115`
represents (the enum name's `ERC721_ERC115` suffix is cosmetic/historical;
the value just means "OZ TimelockController with AccessControl roles"),
and it is the value `b3TenantConfig` already uses for its own OZ
`TimelockController`. `overlay/src/lib/tenant/configs/contracts/fleet.ts`
uses this value, not `TIMELOCK_NO_ACCESS_CONTROL`, with a comment citing
this section.

### ARCHIVE_GCS_BUCKET is not a real env var; the brief's framing needed a deviation

`src/lib/constants.ts`'s `ARCHIVE_GCS_BUCKET` constant (despite its name)
reads only `process.env.ARCHIVE_GCS_BUCKET_OVERRIDE`; there is no plain
"which bucket" env var at all. Unset, it hardcodes a real, unrelated Agora
production bucket URL
(`https://storage.googleapis.com/cpls-usmr-dev-test-26q1` in dev, a
different `cpls-usmr-prd-25q4` one in prod), confirmed by reading the
source (`README.md`/`env.sample` don't document either var at all, so
this is source-only knowledge). Every archive read
(`src/lib/archiveUtils.ts`) is a plain unauthenticated `fetch()` of
`<ARCHIVE_GCS_BUCKET>/data/<namespace>/...`, so leaving this unset for
fleet would not fail loudly; it would silently read whichever unrelated
proposals happen to live in Agora's own real dev bucket instead of
fleet's `fleet-archive-dev` bucket (the one CPLS's `GCS_BUCKET_NAME`
writes to).

This means the task's original framing ("set ARCHIVE_GCS_BUCKET_OVERRIDE
only in the offline overlay file, the way Task 4 did for CPLS's
STORAGE_EMULATOR_HOST") could not be followed literally: CPLS's
`GCS_BUCKET_NAME` (a real bucket-name var, always set, in the *base*
file) has no Agora Next equivalent to lean on. Deviation taken:
`infra/docker-compose.yml`'s `agora-next` service sets
`ARCHIVE_GCS_BUCKET_OVERRIDE: https://storage.googleapis.com/${GCS_BUCKET_NAME:-fleet-archive-dev}`
in the base file (pointed at the real bucket CPLS writes to), and
`infra/docker-compose.offline.yml` overrides only the base URL, to
`http://fake-gcs:4443/${GCS_BUCKET_NAME:-fleet-archive-dev}` - same
variable reused from CPLS's own config for consistency. Verified with
`docker compose ... config`: the merged `agora-next.environment` shows
`ARCHIVE_GCS_BUCKET_OVERRIDE: http://fake-gcs:4443/fleet-archive-dev`
when both files are layered, and would show the `storage.googleapis.com`
form with the base file alone.

### NEXT_PUBLIC_FORK_NODE_URL: one value, two audiences

Traced every read of `NEXT_PUBLIC_FORK_NODE_URL`
(`grep -rn "NEXT_PUBLIC_FORK_NODE_URL"`): `src/lib/rpcConfig.ts`
(`getRpcUrlForChain`, used by every tenant's server-side contract config
including the new `fleet.ts`), `src/lib/utils.ts`, `src/lib/viem.ts`
(`getWalletClient`, used by client components), `src/lib/tenant/tenant.ts`,
and three other tenants' contract configs. None of these branch on
`typeof window`; they all do a plain `process.env.NEXT_PUBLIC_FORK_NODE_URL`
read. Next.js's documented behavior for `NEXT_PUBLIC_`-prefixed vars is to
inline them (via webpack's `DefinePlugin`) into every bundle it compiles,
server and client alike, using whatever value is in `process.env` when
that module is compiled - there is no source-level way to give the server
bundle `http://anvil:8545` and the client (browser) bundle
`http://localhost:8545` from a single `NEXT_PUBLIC_` var without patching
one of these call sites to introduce a second, non-public env var read
with a `typeof window` branch. That patch is outside this task's
registration-only scope (`infra/agora-next/patches/0001-...patch` only
touches the 10 files listed in "Step 1" above).

Confirms the upstream code itself was never designed for this
split-network scenario either: `README.md`'s own documented example is
`NEXT_PUBLIC_FORK_NODE_URL=http://localhost:8545` (line 150), i.e. it
assumes the Next.js dev server and the forked chain run on the same host
the browser is on - exactly the "host-mode" dev setup this task's
decisions section offers as a faster alternative to the Docker build, and
exactly what does NOT hold once Anvil, Postgres, DAO Node, and Agora Next
all run as separate Compose services on their own network.

Decision: set `NEXT_PUBLIC_FORK_NODE_URL=http://anvil:8545` (server-correct)
in `infra/docker-compose.yml`'s `agora-next` service. This is required for
SSR/API-route contract reads to work inside the container (`anvil` only
resolves on the compose network); it is what makes `Tenant.current()`'s
contract construction succeed at all when a page renders. The cost: a
real browser opening this tenant would get the same
`http://anvil:8545` baked into its JS bundle for any client-side chain
read (`getWalletClient` in `viem.ts`, the direct read in `utils.ts`), and
`anvil` does not resolve from the host/browser, so those specific
client-side paths would fail there. This task's verification is
`curl`-based against server-rendered HTML only, which never executes
browser JS, so it does not exercise or get blocked by this gap. Flagged
here for whichever later task first needs live wallet interaction against
this local stack; the fix, if wanted, is a source patch introducing a
second non-public var (e.g. `FORK_NODE_URL_SERVER`) with a
`typeof window === "undefined"` branch in `rpcConfig.ts`, or reverse
proxying the browser's RPC calls through the Next.js server.

### Six more `TENANT_NAMESPACES.B3` call sites left unpatched, on purpose

Beyond the ten files patch 0001 touches, `grep -rl
"TENANT_NAMESPACES.B3\b" src` also finds six more:
`src/app/info/components/GovernorSettingsProposalTypes.tsx`,
`src/app/info/components/InfoAbout.tsx`,
`src/app/api/images/og/assets/shared.tsx`,
`src/app/proposals/components/ProposalStateAdmin.tsx`,
`src/components/DevTools/TenantSwitcher.tsx`, and
`src/components/Proposals/ProposalPage/ShareVoteDialog/TenantLogo.tsx`.
All six are optional/cosmetic per-tenant branching (an admin dev-tools
tenant picker list, an "about" page layout tweak, social-share OG card
SVG art, a proposal-admin feature gate, a share-vote-dialog logo) that
either falls through to a safe default for any unlisted namespace
(boolean `namespace !== X && namespace !== Y...` checks, or a `switch`
with a `default:` case) rather than throwing, and none sit on the
`/proposals` or `/delegates` render path - confirmed empirically, since
neither page threw or logged anything related to these files across
every verification run. Not part of patch 0001, matching the brief's
Step 4 file list, which does not name them. Fleet simply gets each
one's default/fallback treatment, the same as any other tenant these
files don't special-case.

### env_file vs environment: for the agora-next compose service

`infra/agora-next/.env.fleet.example` documents every var (per the task's
"Env for compose from infra/agora-next/.env.fleet.example" instruction),
but `infra/docker-compose.yml`'s `agora-next` service sets them directly
via an `environment:` block, the same pattern every other service in this
file already uses, rather than an `env_file:` pointer at the `.example`
file. Reasoning: Compose's `env_file:` requires the referenced file to
exist (a plain, un-copied `*.example` template would need to be copied to
a real path first, or `docker compose up` errors before the service ever
starts), which would make `agora-next` behave differently from every
other service in this stack - all of which tolerate a completely absent
`infra/.env` via `${VAR:-default}` interpolation. Keeping `agora-next`'s
real values inline in the compose file (with `${GCS_BUCKET_NAME:-...}`
interpolation from `infra/.env` where it needs to match CPLS) preserves
that "works out of the box, no copy step required" property.

### Docker build: npm ci needs python3/make/g++ for a native dependency, not just openssl

The brief's suggested Dockerfile (`git patch openssl` only) failed `npm
ci` on the first real build attempt:
`node-gyp` tried to compile `bufferutil` (an optional native accelerator
`ws`/WalletConnect transitively depend on) from source because no
prebuilt binary exists for this image's architecture/Node version
combination, and failed immediately with "Could not find any Python
installation to use" (no `python3`, no C++ toolchain in
`node:20-bookworm-slim`). Fixed by adding `python3 make g++` to
`infra/agora-next/Dockerfile`'s `apt-get install` line. Did not reproduce
locally with a plain host `npm install` on macOS/arm64 during
verification (a prebuilt `bufferutil` binary exists for that
platform/Node combination), only inside the Linux container - a reminder
that the "develop against vendor/agora-next directly, then prove the
Docker build once" workflow this task's decisions describe can hide a
build-only failure like this one until the final Docker step.

### `vendor/agora-next/.env.local` leaked into the first Docker build

The same host-mode iteration (`.env.local` written in
`vendor/agora-next/` per this task's decisions section, with
`localhost`-based URLs for the host-published ports) left that file on
disk when the first `docker compose build agora-next` ran.
`COPY vendor/agora-next /app` in `infra/agora-next/Dockerfile` copies
whatever is on the host filesystem, gitignored or not (`COPY` only
respects `.dockerignore`, which this Dockerfile's build context does not
define), so that stray `.env.local` (with `DATABASE_URL` pointed at
`localhost:55432`, `DAONODE_URL_TEMPLATE` at `localhost:8000`, etc. -
none of which resolve from inside the container) ended up baked into the
image. It did not actually break anything: Next.js's `@next/env` loader
does not override a variable already present in `process.env` before it
runs, and Docker Compose's `environment:` block sets real process
environment variables before `npm run dev` starts, so the compose-provided
values (`postgres`, `dao-node`, etc.) won every time - confirmed by the
first build's `/proposals` request successfully completing a
`getVotableSupplyFromDaoNode` call (which requires reaching
`dao-node:8000`, not `localhost:8000`). Even so, shipping a host-specific
`.env.local` inside the image is not something Task 6 or a later operator
should have to reason about or accidentally depend on. Fixed by deleting
`vendor/agora-next/.env.local` (confirmed `git -C vendor/agora-next
status --short` was otherwise already clean) and rebuilding with
`docker compose build --no-cache agora-next` to guarantee no stale layer
from the earlier build was reused; the "Boot verification commands and
outputs" section above is from this clean rebuild, not the one with the
leaked file.

### Stub tables added (beyond what infra/postgres/gen-stub.ts already produced from b3's own Prisma views)

Verification proceeded page by page against the live compose stack
(anvil/postgres/dao-node/cpls up via `docker compose -f
docker-compose.yml -f docker-compose.offline.yml`, Agora Next run in
host-mode dev first for fast iteration, then proven once more through the
full Docker build). `/proposals` and `/delegates` (the two pages the
controller ruling requires) rendered cleanly on the very first attempt,
no missing-table errors at all. Continuing on to `/delegates/<address>`
and `/proposals/<id>` (also named in the brief's "Produces" interface
list, though outside the controller's strict verification requirement)
surfaced three more gaps, fixed in `infra/postgres/gen-stub.ts` and
regenerated into `infra/postgres/init/02-agora-stub.sql` /
`03-agora-web2-stub.sql`:

1. **`fleet.vote_cast_events` and `fleet.vote_cast_with_params_events`**
   (`relation "fleet.vote_cast_events" does not exist`, from
   `/delegates/<address>`, `src/app/api/common/votes/getVotes.ts`'s
   `getVotesForDelegateForAddress`, an unconditional raw-SQL path not
   gated by the `use-archive-for-vote-history` toggle). Neither table has
   a `model`/`view` block anywhere in `schema.prisma` for *any* tenant
   (b3 included) - they're read with `${namespace}.vote_cast_events`
   string interpolation directly, bypassing Prisma's model layer
   entirely, so `extractModelsForSchema` had no way to discover them.
   Added as a new hand-written `FLEET_RAW_SQL_TABLES` list in
   `gen-stub.ts` (columns inferred from the exact `SELECT`/`WHERE`
   clauses in `getVotes.ts` and `getVotesChart.ts`: `transaction_hash`,
   `proposal_id`, `voter`, `support`, `weight`, `reason`, `block_number`,
   `params`, `contract`).
2. **Five more `"config"` schema enum types** (`chain`, `contract_type`,
   `dao`, `env`, `proposal_type`) alongside the existing `dao_slug`.
   Surfaced as `type "config"."proposal_type" does not exist` (the same
   `getVotesForDelegateForAddress` query casts a joined column with
   `proposals.proposal_type::config.proposal_type`). `gen-stub.ts`
   previously only special-cased `DaoSlug`; generalized to
   `extractEnumsForSchema(text, "config")`, which walks every `enum { ...
   @@schema("config") }` block and creates all of them generically (still
   appending `'FLEET'` to `dao_slug` specifically, matching the existing
   special case). Also fixed `extractEnumValues` to honor a member's own
   `@map("...")` override (`Chain`'s `optimism_mainnet @map("optimism-mainnet")`
   would otherwise have produced the Prisma-side identifier
   `optimism_mainnet` as the Postgres label instead of the real
   `optimism-mainnet`).
3. **`snapshot.votes`, `snapshot.proposals_v2`, and `snapshot.proposals`**
   (`relation "snapshot.votes" does not exist`, then
   `relation "snapshot.proposals" does not exist`, both from
   `getVotesForDelegateForAddress`'s has-voted/offchain-vote-history
   checks - not fleet-specific at all, every tenant's delegate profile
   page runs these same `"snapshot".votes`/`"snapshot".proposals`
   queries). `schema.prisma` does declare `SnapshotVotes` (`@@map("votes")`)
   and `SnapshotProposal` (`@@map("proposals_v2")`) under `@@schema("snapshot")`,
   but `gen-stub.ts` never extracted the `"snapshot"` schema at all
   (only `"b3"`, `"agora"`, `"config"`) - a pre-existing Task 2 gap, not
   introduced by Task 5, that this is the first task/page combination to
   actually exercise. Fixed by adding `snapshotModels =
   extractModelsForSchema(text, "snapshot")` (picks up the two real
   models) alongside a second hand-written raw-SQL-only entry for
   `snapshot.proposals` (a *different* physical table name than the
   Prisma-modeled `proposals_v2`; the JOIN in `getVotes.ts` line 354
   needs only `id`/`title`). `"snapshot"` was added to both `web3Sql`'s
   and `web2Sql`'s `renderSchemaCreates([...])` calls, matching how
   `"agora"`/`"config"` are already shared across both databases.

Total stub surface for the fleet schema after these fixes: 14 tables from
b3's own Prisma views (unchanged from Task 2) + 2 raw-SQL-only tables = 16
`fleet.*` tables; plus 6 `config.*` enum types (was 1); plus 3
`snapshot.*` tables (was 0). `infra/postgres/gen-stub.ts`'s own console
output after the fix:
```
Wrote 16 fleet table(s) (14 from b3's schema.prisma views, 2 raw-SQL-only), 7 agora table(s), 1 config table(s), 6 config enum(s), 3 snapshot table(s) (2 from schema.prisma, 1 raw-SQL-only) to infra/postgres/init/02-agora-stub.sql and infra/postgres/init/03-agora-web2-stub.sql.
```
`infra/postgres/gen-stub.test.ts`'s existing two tests still pass
unchanged (they only exercise `prismaTypeToPg`/`extractModelsForSchema`/
`renderCreateTable`, none of which changed signature).

Every fix above was scoped generically (by schema, not by tenant), since
none of these three gaps are fleet-specific in the source; they would
have blocked the *same* pages for any tenant that had never exercised
them against this stub Postgres before. Restarting Postgres with a fresh
volume (`docker compose down -v` then `up -d`) was required after each
`gen-stub.ts` regeneration, per this repo's existing convention (init
scripts only run against an empty data directory).

### Verification: what was and wasn't chased down

Per the controller ruling, the required scope is `/proposals` and
`/delegates` returning HTML with no server errors, plus `/delegates`
showing DAO Node's (possibly empty, for placeholder addresses) delegate
list. Both pages returned HTTP 200 with zero server-side errors logged,
on the very first host-mode attempt, before any of the three stub fixes
above were even needed - those three fixes were found and fixed only
because `/delegates/<address>` and `/proposals/<id>` (the brief's
"Produces" list, beyond the controller's strict requirement) were also
spot-checked. After the fixes, all four pages return HTTP 200 with no
database errors. Two remaining non-fatal, expected conditions were left
as-is (not bugs):
- `/delegates/<address>` logs a caught `ENS Resolution Error: No RPC
  secret configured` (from `src/app/lib/ENSUtils.ts`'s
  `getMainnetProvider`, which calls `getRpcUrl` directly rather than
  `getRpcUrlForChain`, so it does not benefit from the
  `NEXT_PUBLIC_FORK_NODE_URL` fallback the tenant contracts use). Expected
  and harmless: this task's env deliberately leaves RPC secrets/WalletConnect/
  Alchemy/EAS/Pinata/Tenderly empty (per the task's own instruction), and
  the error is caught internally - the page still renders 200.
- `/proposals/1` throws (caught, rendered as a normal not-found page)
  `Error: Proposal not found in archive`
  (`src/app/proposals/[proposal_id]/page.tsx:48`). Correct behavior for a
  proposal id that does not exist - no fleet governor has ever been
  deployed against this Anvil instance in this task's verification, so
  zero proposals exist anywhere (chain, DAO Node, or archive). Task 6
  verifies real proposal data once a real deployment exists.

No further raw-SQL table audit beyond what these four pages actually
exercised was undertaken (e.g. `dao_settings`, `badge_definitions`,
`identity_badges`, `delegatees_mat`, and the OPTIMISM-only
`atlas."votes_with_meta_mat"` path all showed up in a broader
`grep -rn '\${namespace}\.'` sweep of the codebase but were never hit by
any of the four pages tested, either because they're gated by toggles
this tenant's UI config leaves disabled - `badges` isn't in
`fleetTenantUIConfig`'s toggle list - or, for `atlas`, gated to
`namespace === TENANT_NAMESPACES.OPTIMISM` specifically). If a later task
exercises a page that hits one of these, the fix is the same pattern
used above: add the table/columns to `gen-stub.ts`, regenerate, restart
Postgres with a fresh volume.

### Boot verification commands and outputs

Host-mode (fast iteration, `vendor/agora-next` with `npm install` +
`.env.local`, against the same Compose-run Postgres/DAO Node/CPLS/fake-gcs
used for the final Docker proof below, host-published ports
`localhost:55432`/`localhost:8000`/`localhost:4443`/`localhost:8545`):

```
$ curl -sS -o proposals.html -w "HTTP %{http_code}\n" http://localhost:3000/proposals
HTTP 200
$ grep -io "application error\|internal server error\|unhandled" proposals.html
(no matches)
$ grep -o "<title>[^<]*</title>" proposals.html
<title>Fleet Governance: Proposals</title>

$ curl -sS -o delegates.html -w "HTTP %{http_code}\n" http://localhost:3000/delegates
HTTP 200
$ grep -o "<title>[^<]*</title>" delegates.html
<title>Fleet Governance: Delegates</title>

$ curl -s http://localhost:8000/v1/delegates
{"delegates":[]}
```

Empty DAO Node delegate list is expected here per the controller ruling
(placeholder addresses, no fleet ever deployed against this Anvil
instance); Task 6 verifies the five-delegate case against a real
deployment.

Full Docker build/boot proof (final step, after reverting
`vendor/agora-next` to pristine and letting the patch + overlay + fresh
`npm ci` do the work exactly as a clean checkout would; `--no-cache` used
here specifically to rule out a stray `.env.local` left over from
host-mode iteration leaking into an earlier cached layer, see
"`vendor/agora-next/.env.local` leaked into the first Docker build" below):

```
$ git -C vendor/agora-next status --short
(clean)
$ docker compose -f docker-compose.yml -f docker-compose.offline.yml build --no-cache agora-next
[... apt-get git/patch/openssl/python3/make/g++, npm ci (89s), prisma generate, generate-typechain ...]
 Image infra-agora-next Built

$ docker compose -f docker-compose.yml -f docker-compose.offline.yml up -d
$ ./scripts/create-fake-bucket.sh
create-fake-bucket: created bucket fleet-archive-dev
$ docker compose -f docker-compose.yml -f docker-compose.offline.yml ps --format '{{.Name}}\t{{.Status}}'
infra-agora-next-1   Up 44 seconds (healthy)
infra-anvil-1        Up About a minute (healthy)
infra-cpls-1         Up 50 seconds (healthy)
infra-dao-node-1     Up 56 seconds (healthy)
infra-fake-gcs-1     Up About a minute
infra-postgres-1     Up About a minute (healthy)

$ curl -sS -o proposals.html -w "HTTP %{http_code}\n" http://localhost:3000/proposals
HTTP 200
$ curl -sS -o delegates.html -w "HTTP %{http_code}\n" http://localhost:3000/delegates
HTTP 200
$ grep -io "application error\|internal server error\|unhandled" proposals.html delegates.html
(no matches)
$ grep -o "<title>[^<]*</title>" proposals.html delegates.html
proposals.html:<title>Fleet Governance: Proposals</title>
delegates.html:<title>Fleet Governance: Delegates</title>
$ curl -s http://localhost:8000/v1/delegates
{"delegates":[]}
```

Re-verified once more after the memory-pressure restart described below
(same commands, same outcome: both pages HTTP 200, no errors, all six
`docker compose ps` services `healthy`).

### `npm run dev`'s memory footprint under Docker Desktop's default VM: observed both a hard OOM-kill and Next's own soft self-restart

Not a fleet-tenant bug; recorded because it affected the verification
run and would affect any tenant on this same Compose stack. `npm run dev`
(`generate-typechain & npx prisma generate & next dev --webpack`, all
three concurrently, matching upstream's own script) compiles each route
lazily on first request rather than ahead of time. After compiling
`/proposals` and `/delegates` sequentially, `docker stats` showed
`infra-agora-next-1` steady at **5.5-5.6 GiB** resident memory, out of
this host's Docker Desktop VM total of 7.65 GiB (`docker info --format
'{{.MemTotal}}'`). Requesting a third, heavier route
(`/delegates/[addressOrENSName]`, which pulls in ENS resolution, the
delegate's onchain and offchain vote history, badges, etc.) while the
automated healthcheck (polling `/proposals` every 10s) and a manual curl
were both also in flight pushed the container over the VM's memory
ceiling: `docker inspect` showed `OOMKilled=true`, a hard kill by the
Linux OOM killer, exit code 0. Restarting the service
(`docker compose up -d agora-next`) recovered it cleanly (matches this
repo's dao-node section's own "a safe workaround while investigating
further" pattern). A second attempt at the same detail page, seconds
after `/proposals`/`/delegates` had just finished a fresh compile (so
under even more memory pressure), didn't hard-crash but did trigger
Next.js 16's own built-in graceful degradation: the log printed
`Server is approaching the used memory threshold, restarting...` and the
dev server restarted itself proactively (not a Docker/kernel-level kill;
`OOMKilled` was `false` for that instance) - the in-flight `curl` request
observed this as a truncated response body after already receiving a 200
status line.

Both instances happened only while probing `/delegates/<address>` (a
page beyond the controller's strict verification requirement, listed in
the brief's "Produces" interface but not the ruling's required scope);
`/proposals` and `/delegates` themselves were re-verified clean
(HTTP 200, no errors, `docker compose ps` showing all six services
`healthy`) immediately after each recovery, with no further crashes
across multiple repeated checks. Given this is Docker Desktop VM memory
provisioning under Next.js dev-mode's real compile-time footprint for a
genuinely large multi-tenant app, not a fleet registration defect, no
source or compose change was made to "fix" it; flagged here for whoever
next works with this container under memory-constrained Docker Desktop
settings. If it recurs and blocks real work, the two straightforward
mitigations are raising Docker Desktop's VM memory allocation, or
avoiding concurrent multi-route compiles the first time a set of pages
is warmed up (e.g. hit pages one at a time, letting each finish
compiling, rather than curling several in parallel).

## Task 6: bootstrap script and the M0 end-to-end proof

Worktree `.worktrees/part2`, branch `part2-agora-stack`. This is the first task to
actually deploy a fleet and drive a real proposal through the whole stack; every
quirk below was found doing that for the first time (Tasks 3-5 each verified their
own service in isolation against placeholder addresses and, at most, a zero-proposal
chain).

### `forge script` cannot write straight into the worktree

`contracts/foundry.toml` on `main` (read-only; this worktree must not modify it)
sets `fs_permissions` to exactly two roots: `./` (`contracts/` itself) and
`../deployments` (`main`'s own `deployments/`, not this worktree's). Neither reaches
into `.worktrees/part2`, so `FLEET_MANIFEST_OUT` pointed directly at this worktree's
`deployments/31337/latest.json` fails: `vm.writeJson: the path ... is not allowed to
be accessed for write operations`. Tried and rejected:

- `--config-path` to a separate `foundry.toml` with a broader `fs_permissions`: this
  flag also changes the base directory solc resolves imports against to the config
  file's own directory, breaking every remapping (`agora-governor/=...`,
  `@openzeppelin/contracts/=...`) regardless of `--root`; adding `-R`/`--remappings`
  and a copy of `remappings.txt` next to the config file still left every import
  resolving against the wrong directory.
- `FOUNDRY_FS_PERMISSIONS` env var override: scalar keys (`FOUNDRY_EVM_VERSION`,
  confirmed) are honoured, but this key holds a `Vec<PathPermission>`; no string
  format tried (TOML array-of-tables, JSON array) changed `forge config --json`'s
  reported value at all.

`bootstrap-local.sh` and `scripted-proposal.sh`'s deploy step instead points
`FLEET_MANIFEST_OUT` at `contracts/.fleet-manifest-tmp.json` (inside the allowed
`./` root, the same class of gitignored build artifact `broadcast/`/`cache/`
already are for any `forge` run there), then moves that file into this worktree's
`deployments/31337/latest.json` and removes the scratch file. `contracts/` itself
is left exactly as it started (confirmed with `git status --short contracts/`
before and after); the same precedent Task 5's controller notes already used for
`forge build` there.

### docker compose up --build recreates Anvil out from under a deployed fleet

**Symptom.** Deploying the fleet (`forge script`, against the already-running
compose `anvil`), then bringing up `dao-node`/`cpls`/`agora-next` with
`docker compose up -d --build dao-node cpls agora-next fake-gcs`, silently wiped
the chain: `scripted-proposal.sh`'s first `cast send` (`openTask`) reported
`status=0x1` (a transaction sent to an address with no code neither reverts nor
does anything; the EVM has nothing to execute, so the receipt is trivially a
success), but the very next `cast call` (`taskCount()`) failed outright:
`Error: contract 0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9 does not have any
code`. `cast code <ledger>` against the running stack confirmed it directly:
`0x` (empty) where the just-deployed ledger's bytecode should have been, and
`docker inspect infra-anvil-1 --format '{{.State.StartedAt}}'` showed a
container barely seconds old, `cast block-number` showing a block count far
lower than the amount of real wall-clock time already elapsed (a fresh chain,
not the one the deploy script had just broadcast to).

**Root cause.** Every service here shares one Docker build context
(`context: ..`, this entire worktree, in every `infra/*/Dockerfile`'s compose
entry). `docker compose up --build <subset>` resolves the full dependency
graph of the named services (here, `anvil` is a transitive dependency of
`dao-node`/`blockcache-shim`) and rebuilds every image in that graph, not
just the ones named on the command line. Anvil's own `Dockerfile` does not
`COPY` anything from that shared context (`FROM ghcr.io/foundry-rs/foundry:v1.7.1`
plus a bare `ENTRYPOINT`), so its build is a 100% cache hit every time, but
BuildKit still produces a *new* image (attestation/provenance metadata and
build timestamps differ even across a fully cached rebuild), so Compose sees
a changed image ID for the `anvil` service and recreates the container to
match it, silently, with no explicit "Recreate" line surviving in a piped,
non-TTY log capture in every case observed (`docker inspect`'s `CreatedAt` was
the reliable signal, not the compose CLI's own progress text). Anvil keeps
its whole chain state in memory with no volume (unlike `postgres`, which
Compose also may recreate the container for, but whose data survives via
`postgres-data`), so any recreation is a full reset to genesis.

**Fix: build once, up never rebuilds again.** `bootstrap-local.sh`'s step 0
(`compose build anvil dao-node cpls agora-next blockcache-shim`) builds every
image exactly once, before any container exists. Every later step uses plain
`compose up -d <services>` with no `--build` flag at all, so no image ever
changes again during the run and nothing gets recreated to "match" a newer
one. Verified directly: with the fix in place, re-running
`docker compose up -d dao-node cpls agora-next blockcache-shim fake-gcs`
against an already-deployed fleet left `cast code <ledger>` returning the
real bytecode and `cast block-number` continuing to climb from where it had
been, both before and after the command; without it (the version of
`bootstrap-local.sh` that still passed `--build` to that same `up` call), the
ledger's code and every prior block were gone.

### DAO Node's realtime client silently never starts: `NUM_ARCHIVE_CLIENTS` off-by-one

With only `NUM_REALTIME_CLIENTS`/`NUM_POLLING_CLIENTS` set (Task 3's mitigation for
the cold-boot hang, unchanged here), `GET /v1/progress` showed `realtime_counts: {}`
permanently, even minutes after boot with Anvil mining a block every 2 seconds: the
archive client's one-time catch-up scan worked (`archive_counts` populated
correctly), but nothing tracked new blocks afterward, so a proposal opened after
boot was invisible until the container was restarted (which re-runs the one-time
archive catch-up and briefly "sees" it, but still never tracks anything live from
that point on).

Root cause: `app/server.py`'s `NUM_ARCHIVE_CLIENTS` defaults to `2` (a CSV archive
slot plus the HTTP one), and `subscribe_feeds()` computes each realtime client's
position in the combined client list as `1 + NUM_ARCHIVE_CLIENTS + i`. This
deployment's CSV archive client is invalid (`DAO_NODE_DATA_PATH`/`data/` is never
configured; boot logs `The path 'data' does not exist, this client is not valid for
CSVClient` and it is excluded from the live list), so the real list is only 2 long
(1 archive, 1 realtime), but the realtime client's computed position is 3. Its own
`async for i, client in self.cs.get_async_iterator():` scan (`Feed.realtime_async_read`)
cycles through the 2 real clients, never matches position 3, hits
`StopAsyncIteration`, and the task exits normally with no error logged anywhere.

Fixed with `NUM_ARCHIVE_CLIENTS: "1"` in `infra/docker-compose.yml`'s `dao-node`
service (no source patch needed). Verified: `GET /v1/progress` showed
`realtime_counts: {"31337.blocks.JsonRpcRtWsClient": N}` growing on every poll after
the fix, `0` (missing entirely) before it.

### `infra/dao-node/patches/0005`: `/v1/proposal_types` returns an empty list with no `ProposalTypesConfigurator`, and CPLS cannot tolerate that

Fleet Governance v1 deploys no onchain `ProposalTypesConfigurator` (no `ptc` key in
the deployment config), so `app.ctx.proposal_types` never exists. Patch 0002
already makes every `agora` v2 `ProposalCreated` event carry a `proposal_type_id`
regardless (defaulting to `0` when the description has no `#proposalTypeId=`
marker, per the spec). `GET /v1/proposal_types`'s untracked-case fallback served
`{'proposal_types': []}` (a list); `cpls/sync_daonode.py`'s
`response.json()['proposal_types'][str(proposal_type_id)]` raised (`list indices
must be integers, not 'str'`) against it, and `refresh_list`'s blanket
`try/except` around that whole block turned that into silently skipping the
proposal forever (`skipped_count += 1; continue`), before ever archiving its
votes. Fixed by serving a single default entry for id `0` instead (see the
patch's own header comment for the exact code and reasoning).

### `infra/dao-node/patches/0006`: no `voting_module_name` for a plain `propose()` call

`Proposals._handle_ProposalCreated` only calls `proposal.set_voting_module_name(...)`
from two places: the `PROPOSAL_CREATED_MODULE` branch (approval/optimistic voting
modules) and, for a non-`agora` governor, an unconditional `'standard'` default. An
`agora` v2 governor's plain `ProposalCreated` event (the only kind Fleet Governance
v1 ever emits: it calls the base `propose()`, never a voting module) falls through
neither branch, so `proposal.voting_module_name` is never set and `to_dict()`'s
JSON never carries a `voting_module_name` key for such a proposal.
`cpls/sync_daonode.py`'s `refresh_list` reads
`approval = proposal['voting_module_name'] == 'approval'` as a plain dict lookup
(no `.get()`), raising `KeyError('voting_module_name')` and aborting the sync. This
module's own downstream reads of the same attribute are defensive (`hasattr()`
checks), so it never crashed DAO Node itself; only CPLS's stricter read surfaced
it. Fixed by also calling `set_voting_module_name('standard')` in the agora-v2
branch (matching the non-agora branch's own default for the same "no real voting
module" case).

### `infra/dao-node/patches/0007`: `Proposal.to_dict()` never calls its own `start_block`/`end_block` properties

The class already has `start_block`/`end_block` properties
(`_get_block_value('start_block', 'vote_start')`, an existing fallback across the
naming difference between older and newer governor event shapes), but `to_dict()`
(what `GET /v1/proposal/<id>` actually serves) just returns raw `create_event`,
which for the standard `agora` `ProposalCreated` event has `vote_start`/`vote_end`,
never `start_block`/`end_block`. `cpls/sync_daonode.py`'s `refresh_list` reads
`proposal['start_block']` as a plain dict lookup near the very start of its
per-proposal processing (computing `after_start_block`), so this raised
`KeyError('start_block')` for every fleet proposal, before token/governor address
filtering or vote archiving ever ran. Fixed by copying the two properties'
already-computed values into the dict inside `to_dict()`.

### CPLS reads votes from Postgres, not from DAO Node

`cpls/sync.py`'s `read_votes_from_db()` (used by every DAO-node-source sync, i.e.
`cpls/sync_daonode.py`'s `DaoNodeSync`) queries `"{dao_slug}"."votes"` directly
(`SELECT transaction_hash, block_number, chain_id, voter, support, weight, reason,
params FROM {slug}.votes WHERE proposal_id = '...' AND contract = '...'`), a real
Postgres table, not DAO Node's own `/v1/vote_record/<id>` API. In production a
separate indexing pipeline (the `auazure`/`alltenant` schemas CPLS's other queries
read) populates it; this local stack has none. The table itself already existed as
a stub with the right columns (`infra/postgres/gen-stub.ts`'s `fleet.votes`, one of
the 14 tables copied from `b3`'s own Prisma view, unrelated to the
`vote_cast_events`/`vote_cast_with_params_events` raw-SQL tables Task 5 added,
which are only Agora Next's own delegate-page query, `getVotes.ts`; a second,
genuinely different `fleet.votes`-shaped need this task's own testing was the first
to exercise). `infra/scripts/scripted-proposal.sh` inserts one row per real
on-chain vote itself, right after casting it (`insert_vote_row`, via
`docker compose exec postgres psql`). This table is a cache of on-chain fact,
not a second source of truth for anything the script itself decided: every
column is either read straight back off the chain (the transaction's own
receipt or its `VoteCast` event), or a deployment constant read from the
manifest. `support` is stored as the raw numeric `0`/`1`/`2`, matching what
`src/lib/voteUtils.ts`'s `parseSupport` expects for the non-Optimism,
non-approval-module default case.

| Column | Source |
| --- | --- |
| `proposal_id` | `cast call ... getProposalId(...)`, the governor's own deterministic hash of this proposal's targets/values/calldatas/description; not a chain event, but a chain-computed value, re-derived the same way DAO Node and the chain itself would |
| `transaction_hash` | the `castVoteWithReason` transaction's own receipt (`.transactionHash`) |
| `block_number` | the same receipt (`.blockNumber`) |
| `chain_id` | deployment constant, read from `deployments/31337/latest.json`'s `.chainId` (not hardcoded) |
| `voter` | `cast wallet address --private-key <member's key>`; deterministic from the same key the vote was signed with, so it is exactly that transaction's `msg.sender` |
| `support` | the value passed as the `support` argument to `castVoteWithReason`; a script input, and by construction exactly what the chain recorded (the same value the transaction that became this receipt was sent with) |
| `weight` | **read back from the `VoteCast` event** the vote's own receipt emitted (`voter` is `topics[1]`; `proposalId, support, weight, reason` are the non-indexed `data`, ABI-decoded with `cast decode-abi`, matching the ABI's own field order: `weight` is the event's fourth argument). Not a constant: earlier versions of this script hardcoded `1e18` here (every member's voting power in this deployment, but a coincidence of fixture data, not something the script should assume); see "the vote weight bridge column was a hardcoded constant" below |
| `reason` | the value passed as the `reason` argument to `castVoteWithReason`; a script input, exactly what the chain recorded for the same reason `support` is |
| `params` | always `NULL`: this governor has no voting module that uses it (`cpls/sync_daonode.py`'s `approval = proposal['voting_module_name'] == 'approval'` check is `false` for every fleet proposal), so there is nothing to read back |
| `contract` | deployment constant, the governor's own address (from the manifest), lowercased to match `gov_addr.lower()`'s filter |

### The vote weight bridge column was a hardcoded constant

The first version of `insert_vote_row` set `weight` to a literal
`1000000000000000000` (1e18) for every row, reasoning that every member of
this fixed five-member fleet holds exactly one vote's worth of `FleetVotes`
and nothing here ever changes that. That reasoning happens to be true for
this deployment, but the column exists to carry the real, chain-recorded
weight of each vote (delegation could, in general, make different members'
weights differ even in a small fleet), and a script that inserts a plausible
constant instead of reading the fact back off the chain undermines the
"cache of on-chain fact, not a second source of truth" property every other
column in this table already has. Fixed: `cast_vote()` now decodes the real
`weight` off each vote's own `VoteCast` event (see the table above) and
passes it through to `insert_vote_row`. Verified after the fix, comparing
the inserted row against the chain directly:

```
$ PID=70719344765219781223949422325111121206638320504507403755309964502293377655188
$ docker compose exec -T postgres psql -U agora -d agora_web3 -t -A -c \
  "SELECT voter, weight FROM fleet.votes WHERE proposal_id = '$PID' ORDER BY block_number;"
0x70997970c51812dc3a010c7d01b50e0d17dc79c8|1000000000000000000
0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc|1000000000000000000
0x90f79bf6eb2c4f870365e785982e1f101e93b906|1000000000000000000
0x15d34aaf54267db7d7c367839aaf71a00a2c6a65|1000000000000000000
0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc|1000000000000000000

$ TOKEN=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
$ for v in 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC \
  0x90F79bf6EB2c4f870365E785982E1f101E93b906 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 \
  0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc; do
    cast call $TOKEN "getVotes(address)(uint256)" $v --rpc-url http://127.0.0.1:8545
  done
1000000000000000000 [1e18]
1000000000000000000 [1e18]
1000000000000000000 [1e18]
1000000000000000000 [1e18]
1000000000000000000 [1e18]
```

Every inserted `weight` equals `token.getVotes(voter)` at the time of the
vote, read two different ways (the `VoteCast` event's own recorded weight,
and a direct call against the token), because the governor's snapshot
voting power *is* `getVotes` at the proposal's snapshot block, and this
fixed fleet never changes anyone's balance or delegation after deployment.

`infra/postgres/gen-stub.ts` also needed a second, new stub for CPLS specifically
(not Agora Next): `cpls/sync.py`'s `get_vp_snapshot_all_delegates_from_db()`
(building the archived "who hasn't voted yet" list, called unconditionally once a
proposal's voting period has started) queries
`auazure."<index_tenant_prefix>_token_delegate_votes_changed"`, a schema/table with
no `schema.prisma` model for any tenant at all, unguarded by any
`try`/`except`. Stubbed as `AUAZURE_RAW_SQL_TABLES` (`delegate`, `address`,
`block_number`, `new_votes`, plus `new_balance`/`previous_balance` for headroom);
empty rows are correct here, not just tolerated, since fleet's UI config exposes no
non-voter list feature.

### CPLS's block-timestamp lookups need a working `BlockCacheClient`

`cpls/sync.py`'s `get_timestamp()` calls `self.bc.get_blocktime(...)`
(`BlockCacheClient`, `cpls/blockcache.py`) completely unguarded, for every
proposal's `start_blocktime`/`end_blocktime`/`timestamp`, before the votes archive
blob is even written. `BLOCKCACHE_URL` defaults to a real, external, hosted
service for other DAOs' mainnet/L2 chains, with no notion of a local Anvil chain
and (in this sandboxed environment) no network path to reach anyway; pointing it
at an address nothing listens on (tried first, to fail fast) still broke every
sync, since this call has no fallback.

`infra/blockcache-shim` (new service) is a small stand-in implementing the handful
of `blockcache.py` endpoints this stack's syncs actually call
(`/exact_blocktime`, `/estimated_blocktime`, `/contract_call`, `/transaction`),
backed by this stack's own Anvil via plain JSON-RPC, listening on the same port
(`:8002`) `blockcache.py`'s own `__main__` block already uses as its local-dev
convention. One correctness detail: `contract_call_encoded()` sends only the
ABI-encoded arguments in its request body (`data`), never the 4-byte function
selector; the shim derives the selector itself from the request's
`method_signature` field before calling `eth_call`, matching what the real
service must also do.

One remaining unguarded call in this same file (`self.bc.contract_call_encoded(...,
'state(uint256)', ...)`, reached only once a proposal's voting period has ended but
it is not yet archived, i.e. between `queue` and `execute`; `queue_event` alone
does not set `liveness = 'archived'`, only `execute_event`/`cancel_event` do) is
avoided by design rather than by the shim: `scripted-proposal.sh` does not trigger
a CPLS sync between `queue` and `execute` (it syncs at proposed, voted, and
executed; see that script's comment at the queue step). The shim's `/contract_call`
would handle this correctly too (verified separately), so a future task that wants
a "Queued" archive snapshot can add that sync back safely.

### blockcache-shim's /exact_blocktime always answered, so CPLS's estimate fallback never ran

The first version of `infra/blockcache-shim/server.py` shared one `blocktime()`
helper between `/exact_blocktime` and `/estimated_blocktime`: for a block that
had not been mined yet, that helper extrapolated an estimate and returned it as
`{"ts": <estimate>}` from *both* routes. `BlockCacheClient.return_ts()`
(`cpls/blockcache.py` lines 52-60) treats any response carrying a truthy `ts`
key as authoritative and returns it directly; it only raises `BlockNotFound`
(which `get_blocktime()`, lines 75-79, catches to retry against
`/estimated_blocktime`) when `ts` is absent and `msg == 'block not found'`. With
the shared helper, `/exact_blocktime` never produced that shape for an unmined
block, so the fallback path was dead code: every "not yet mined" lookup was
silently served an estimate mislabeled as exact.

Fixed by splitting into two functions: `exact_blocktime()` returns the real
block's timestamp or `None` (never extrapolates); `estimated_blocktime()` is
the only one that may extrapolate, always returning a value. The HTTP layer
turns `None` into `{"msg": "block not found"}` with no `ts` key at all, on a
`404`, for `/exact_blocktime` only.

Verified directly against the running shim, for both a real (already-mined)
block and a block far in the future of the chain's current tip (chain tip
was block 850 at the time):

```
$ docker exec infra-blockcache-shim-1 python3 -c "
import urllib.request, json
for path in ['/exact_blocktime/31337/1', '/exact_blocktime/31337/1850', '/estimated_blocktime/31337/1850']:
    try:
        with urllib.request.urlopen('http://localhost:8002' + path, timeout=5) as r:
            print(path, r.status, r.read().decode())
    except urllib.error.HTTPError as e:
        print(path, e.code, e.read().decode())
"
/exact_blocktime/31337/1 200 {"ts": 1789376041}
/exact_blocktime/31337/1850 404 {"msg": "block not found"}
/estimated_blocktime/31337/1850 200 {"ts": 1789379742}
```

`/exact_blocktime` on the real block returns `{"ts": ...}`; on the future
block it returns exactly `{"msg": "block not found"}`, no `ts` key, which
`return_ts()` maps to `BlockNotFound`. `/estimated_blocktime` on the same
future block returns an actual `{"ts": ...}` estimate. `infra/blockcache-shim`
has no test layout of its own (a single-file stdlib HTTP server, no pytest
config or fixtures anywhere under that directory), so this curl-equivalent
transcript is the verification for this fix, not a unit test.

### `/v1/vote_record/<id>` is `{vote_record: [...], has_more: bool}`, not a bare array

The brief's own acceptance command (`curl ... | jq 'length'  # 5`) assumes a bare
array; DAO Node's actual response wraps it. `jq 'length'` on the real response
returns `2` (the object's own key count) regardless of how many votes exist,
silently reporting the wrong number instead of erroring. `scripted-proposal.sh`'s
own wait condition had exactly this bug during development (see its git history
were this not squashed); fixed to `jq -e '.vote_record | length == 5'`. The
correct read for the acceptance check is `jq '.vote_record | length'`.

### Agora Next's archive reads all fail silently: Next.js 16's patched `fetch()` cannot read a gzip response body server-side

`src/lib/archiveUtils.ts`'s `fetchArchiveNdjson`/`fetchArchiveGzipJson` (the only
two archive-object readers; every proposal list/detail, vote-history, and
delegates-archive read goes through one of them) used the global `fetch()`, then
decompressed server-side with `zlib.gunzipSync` (`isBrowser` is `false` there, so
the `DecompressionStream` branch never runs). Every one of those `fetch()` calls
threw `TypeError: controller[kState].transformAlgorithm is not a function` in this
container (Next.js 16.2.6, Node 20.20.2), logged in "ignore-listed" (framework)
frames. Confirmed this is Next's own patched `fetch()` (used for its Data
Cache/request-dedup instrumentation, active even with `cache: "no-store"`), not
this file's logic or the archive server's response: the identical request against
the identical URL, made with plain `node -e` outside Next.js, succeeded every
time. Every call site already wraps the eventual failure in a `try`/`catch` that
quietly returns an empty list/null, so every affected page still rendered `200 OK`
with no visible error, just silently empty of archive data.

Fixed with `infra/agora-next/patches/0002`: both functions now read the response
via `node:http`/`node:https` directly (server-side only; client-side still uses
plain `fetch()`, since `node:http` does not exist there and no browser session hit
this bug). One follow-up bug in the first version of that fix: a single
`await import(url.startsWith("https:") ? "https" : "http")` (one dynamic import
keyed on a runtime ternary) is something webpack (which also bundles this file's
server code) can only warn about (`Critical dependency: the request of a
dependency is an expression`), not resolve; it silently left the import broken at
runtime. Splitting into two separate `import("https")`/`import("http")` calls,
each with its own string literal, let webpack resolve both correctly.

### `fake-gcs-server`'s path-style object access is host-gated

Even after the fetch fix above, every archive read from *inside* the Docker
network still 404'd (`data/fleet/proposal_list.full.ndjson.gz` and friends),
while the identical path worked from the host machine. `ARCHIVE_GCS_BUCKET_OVERRIDE`
builds a plain path-style URL (`http://fake-gcs:4443/<bucket>/<object>`, the
public-object-access shape real `storage.googleapis.com` supports, not the JSON
API's `/storage/v1/b/.../o/...`), and `fake-gcs-server` 404s that specific
endpoint whenever the request's `Host` header does not exactly match its
`-public-host` flag. `infra/docker-compose.offline.yml` set
`-public-host localhost:4443`, which only ever matched requests made directly from
the host machine (this project's own verification `curl`s and
`create-fake-bucket.sh`'s `POST`, which go through the *JSON* API and are not
host-gated the same way, so they never surfaced this): every container-to-
container request (Agora Next's own server-side archive fetches; its own compose
network hostname for that service is `fake-gcs`) sent `Host: fake-gcs:4443` and
404'd. Fixed by changing `-public-host`/`-external-url` to `fake-gcs:4443`,
matching what every actual reader of that URL sends.

### The proposal's vote list (with reasons) is a client component; `curl` cannot see it

`ArchiveProposalVotesList` (`src/components/Votes/ProposalVotesList/`) is a
`"use client"` component: it fetches `/api/archive/votes/<id>` (no auth header) in
the browser, after hydration, via `useArchiveProposalVotes`'s React Query hook.
This is architectural, not a bug: a plain `curl` of `/proposals/<id>`'s initial
HTML will never contain the individual votes or their reasons, no matter how
correct the archive pipeline is, since that content is never part of the
server-rendered response (confirmed: `grep -c "Charter forbids"` against that
HTML is `0`). What this task actually verified instead, directly against the
same route the browser calls after hydration
(`curl localhost:3000/api/archive/votes/<id>`): all five votes come back with
their exact reason text, including the Against reason the brief's acceptance
check looks for:

```
$ curl -s "http://localhost:3000/api/archive/votes/$PID" | jq -r '.data[].reason' | grep -c "Charter forbids"
1
$ curl -s "http://localhost:3000/api/archive/votes/$PID" | jq -r '.data[2].reason'
AGAINST. Charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy; the task remains solvable from the repository. [flags: scope, provenance; confidence: 0.82]
```

This task did not open the page in an actual browser; that would be the
strongest possible confirmation this renders for a real user, but it was not
performed, so it is not claimed here. The proposal's own status ("Executed")
and FOR/AGAINST vote *totals* (`3`/`2`) *are* server-rendered (they come from
the proposal object itself, not the separate votes list), and did show
correctly in a plain `curl` of `/proposals/<id>`.

### `npm run dev`'s memory-threshold self-restart can interrupt an in-flight archive-object first-fetch

Once, while the `/api/archive/votes/[proposalId]` route was compiling for the
first time under concurrent load (healthcheck polling plus manual verification
curls), the dev server printed `Server is approaching the used memory threshold,
restarting...` mid-request, and the in-flight `curl` got an empty reply
(`curl: (52) Empty reply from server`). This is the same Docker-Desktop-VM-memory
condition Task 5's compatibility notes already documented for `/delegates`; not
fleet-specific, and the retried request succeeded immediately once the server
finished its self-restart (`✓ Ready in 267ms`).
### M0 evidence block

Full clean run: `docker compose -f docker-compose.yml -f docker-compose.offline.yml
down -v` (removes the postgres volume too, so the new `auazure` schema/table gets
created by the init scripts), then `bash infra/scripts/bootstrap-local.sh`. Deployed
addresses this run: `registry 0x5FbDB2315678afecb367f032d93F642f64180aa3`,
`token 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`,
`timelock 0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0`,
`ledger 0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9`,
`hook 0xA8d43557A9D305D0B2F98BfEbe07dC0A8DB522c0`,
`governor 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707` (registry/token/timelock/
ledger are deterministic CREATE addresses from Anvil's default deployer at nonce 0
on a fresh chain, hence identical across runs; the hook's mined CREATE2 salt is not
deterministic run to run, observed to differ).

Executed proposal id:
`107527385984923766767650463693504513028928175055284733252656629127126744840522`
(`PID` below). Full transcript of `bootstrap-local.sh`'s own output is long (image
builds plus the full lifecycle); the governance-relevant lines:

```
== opening task (operator) ==
tx=0xe56ded4becdbf76b2cc928a5ec80ae2e1c154e43824950529938206fd73383c5 status=0x1
scripted-proposal: TASK_ID=1
scripted-proposal: computed PID=107527385984923766767650463693504513028928175055284733252656629127126744840522
== proposing (member 1) ==
tx=0x1b11c98b9dc8bd2cb5dd318ee6a303a593df8830fea22ac56cb142ffec6a2ad5 status=0x1
scripted-proposal: state after propose: 0
wait-for: DAO Node to index proposal ... OK (0s)
== syncing CPLS after stage: proposed ==
scripted-proposal: cpls job c08ce88c-... completed
wait-for: archive votes/... object after proposed OK (0s)
scripted-proposal: state now Active: 1
== casting five votes: For, For, Against, For, Against ==
scripted-proposal: member 1 voted (support=1) tx=0x3d54d5a7... block=43
scripted-proposal: member 2 voted (support=1) tx=0x2bcd4c16... block=44
scripted-proposal: member 3 voted (support=0) tx=0x0515ff6a... block=45
scripted-proposal: member 4 voted (support=1) tx=0x5d1cd60f... block=46
scripted-proposal: member 5 voted (support=0) tx=0x8cd4cb7d... block=47
2000000000000000000 [2e18]   # against
3000000000000000000 [3e18]   # for
0                             # abstain
wait-for: DAO Node to index all five votes for ... OK (0s)
== syncing CPLS after stage: voted ==
scripted-proposal: cpls job e05ec2cb-... completed
wait-for: archive votes/... object after voted OK (0s)
scripted-proposal: state after voting period: 4 (4=Succeeded, 3=Defeated)
== queueing (operator; queue/execute are permissionless, any key works) ==
tx=0x5cdcc534826500720317a6464261d9ae55eb08867f3bfa634c1c271c5fc8757d status=0x1
scripted-proposal: state after queue: 5
== sleeping past the timelock delay (30s + 5s margin) ==
== executing ==
tx=... status=0x1
scripted-proposal: state after execute: 7
wait-for: DAO Node to index execution of ... OK (0s)
== syncing CPLS after stage: executed ==
scripted-proposal: cpls job c53d31f9-... completed
wait-for: archive votes/... object after executed OK (0s)
scripted-proposal: ledger.exceptionVersion(1, 0xb1f59f0011f1901a6afa6c5dbd3aa3d715c2045ce4f7858d7bd2e29560630b60) = 1
scripted-proposal: done.
PROPOSAL_ID=107527385984923766767650463693504513028928175055284733252656629127126744840522
bootstrap-local: proposal 107527385984923766767650463693504513028928175055284733252656629127126744840522 executed.
bootstrap-local: Agora Next: http://localhost:3000/proposals/107527385984923766767650463693504513028928175055284733252656629127126744840522
```

The five reasons (spec section 8.3's format), in vote order:

1. FOR. Needed to finish task 1 within budget; examples.internal is a controlled internal mirror with no evidence of exfiltration risk. [flags: scope; confidence: 0.88]
2. FOR. I proposed this after exhausting repository-only options; the fetch is scoped to reference tests only and is time-boxed to this task. [flags: scope; confidence: 0.9]
3. AGAINST. Charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy; the task remains solvable from the repository. [flags: scope, provenance; confidence: 0.82]
4. FOR. Cheap, reversible, and time-boxed to this one task; blocking it stalls the suite for no safety benefit. [flags: scope; confidence: 0.75]
5. AGAINST. The examples.internal host has not been vetted through the fleet's allowlist review process and approving now sets precedent for ad hoc exceptions. [flags: provenance; confidence: 0.7]

For-only quorum: 3e18 FOR (>= quorum 60% of 5e18 = 3e18) and 3e18 > 2e18 AGAINST, so
Succeeded, matching `FleetHook.beforeVoteSucceeded`'s rule.

#### Every acceptance check, command and output

```
$ PID=107527385984923766767650463693504513028928175055284733252656629127126744840522

$ curl -s localhost:8000/v1/proposals | jq '.proposals | length'
1

$ curl -s localhost:8000/v1/vote_record/$PID | jq '.vote_record | length'
5
# (the brief's own `jq 'length'` returns 2 here, the response object's own key
# count, not the array; see "the /v1/vote_record/<id> is {vote_record, has_more}"
# above)

$ curl -s "localhost:4443/storage/v1/b/fleet-archive-dev/o" | jq -r '.items[].name' | grep "votes/$PID"
data/fleet/votes/107527385984923766767650463693504513028928175055284733252656629127126744840522.ndjson
data/fleet/votes/107527385984923766767650463693504513028928175055284733252656629127126744840522.ndjson.gz

$ curl -s localhost:3000/proposals | grep -c "Grant exception"
1

$ curl -s localhost:3000/proposals/$PID -o detail.html; grep -c "Charter forbids" detail.html
0
# The vote list (with reasons) is a client component (`ArchiveProposalVotesList`,
# "use client") fetching /api/archive/votes/<id> after hydration; see "The
# proposal's vote list ... curl cannot see it" above. Verified the data itself two
# ways instead:

$ curl -s "http://localhost:3000/api/archive/votes/$PID" | jq '.data | length'
5
$ curl -s "http://localhost:3000/api/archive/votes/$PID" | jq -r '.data[].reason' | grep -c "Charter forbids"
1

$ grep -io "Executed" detail.html | sort -u
executed
Executed
EXECUTED

$ cast call 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 "state(uint256)(uint8)" $PID --rpc-url http://127.0.0.1:8545
7   # Executed, matches the page

$ curl -s localhost:8000/v1/delegates | jq '.delegates | length'
5
$ curl -s "localhost:8000/v1/balance/0x70997970C51812dc3A010C7d01b50e0d17dc79C8" | jq
{"balance": "1000000000000000000", "address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}

$ curl -s localhost:3000/delegates -o delegates.html
$ grep -o '1<!-- --> <!-- -->FLEET' delegates.html | wc -l
5
```

#### Reproducibility: delete the bucket, re-trigger CPLS, re-check

```
$ curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o" | jq -r '.items[].name' \
  | while read -r name; do
      enc=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$name")
      curl -s -o /dev/null -w "%{http_code} $name\n" -X DELETE "http://localhost:4443/storage/v1/b/fleet-archive-dev/o/$enc"
    done
200 data/fleet/proposal/dao_node/raw/<PID>.json
200 data/fleet/proposal/dao_node/raw/<PID>.json.gz
200 data/fleet/proposal_list.full.ndjson
200 data/fleet/proposal_list.full.ndjson.gz
200 data/fleet/proposal_list/dao_node/raw.ndjson
200 data/fleet/proposal_list/dao_node/raw.ndjson.gz
200 data/fleet/votes/<PID>.ndjson
200 data/fleet/votes/<PID>.ndjson.gz
200 jobs/scheduled/... (x8)
200 jobs/sync_daonode/... (x3)

$ curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o"
{"kind":"storage#objects"}    # confirmed empty

$ curl -s -X POST localhost:8001/jobs -H 'content-type: application/json' -d @sync-job.json
{"job_id":"2d063937-c294-408c-aa9a-1d22436fbc3b","status":"queued"}
$ curl -s localhost:8001/jobs/2d063937-c294-408c-aa9a-1d22436fbc3b
{"id":"2d063937-...","type":"sync_daonode","status":"completed","error":null,...}

$ curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o" | jq -r '.items[].name' | sort
data/fleet/proposal/dao_node/raw/<PID>.json
data/fleet/proposal/dao_node/raw/<PID>.json.gz
data/fleet/proposal_list.full.ndjson
data/fleet/proposal_list.full.ndjson.gz
data/fleet/proposal_list/dao_node/raw.ndjson
data/fleet/proposal_list/dao_node/raw.ndjson.gz
data/fleet/votes/<PID>.ndjson
data/fleet/votes/<PID>.ndjson.gz
jobs/sync_daonode/20260914_090234_2d063937-c294-408c-aa9a-1d22436fbc3b.json

$ curl -s localhost:3000/proposals | grep -c "Grant exception"
1
$ curl -s localhost:3000/proposals/$PID -o detail2.html; grep -io Executed detail2.html | sort -u
executed
Executed
EXECUTED
$ curl -s "http://localhost:3000/api/archive/votes/$PID" | jq '.data | length'
5
```

Every object, both pages, and the API route all reconstructed correctly from an
empty bucket.

#### DAO Node and CPLS env vars, confirmed from source (this task's additions)

| Var | Service | Confirmed at |
| --- | --- | --- |
| `NUM_ARCHIVE_CLIENTS` | dao-node | `app/server.py`, default `2`; see "DAO Node's realtime client silently never starts" above |
| `BLOCKCACHE_URL` | cpls | `cpls/config.py` line 18; consumed by `cpls/sync.py`'s `self.bc = BlockCacheClient(...)` |
| `DATABASE_URL` | cpls | `cpls/config.py` line 17 (`os.getenv("DATABASE_URL")`), consumed by `cpls/sync.py`'s `self.pg = PostgreSQLClient(DATABASE_URL)` |

(Every other env var this task relies on was already confirmed in Tasks 3-5's own
sections above; not re-listed here.)

#### Stub tables Agora Next and CPLS needed, complete list (all tasks)

- `fleet.*` (14 tables, from `b3`'s own Prisma views) + `fleet.vote_cast_events`,
  `fleet.vote_cast_with_params_events` (raw SQL), Task 2/5.
- `agora.*` (7 tables), Task 2.
- `config.*` (1 table + 6 enum types), Task 2/5.
- `snapshot.*` (2 tables from `schema.prisma` + `snapshot.proposals` raw SQL), Task 5.
- `auazure.fleet_token_delegate_votes_changed` (raw SQL), **Task 6**, for CPLS's
  `get_vp_snapshot_all_delegates_from_db()`; see above. The only stub added by this
  task; `fleet.votes` (CPLS's actual vote source) already existed from Task 2/5's
  `b3`-derived views.

#### Pages verified

`http://localhost:3000/proposals` (proposal title), `/proposals/<id>` (status,
vote totals; votes+reasons via `/api/archive/votes/<id>`), `/delegates` (five
members, `1 FLEET` each). DAO Node: `/v1/progress`, `/v1/proposals`,
`/v1/proposal/<id>`, `/v1/vote_record/<id>`, `/v1/delegates`, `/v1/balance/<addr>`.
CPLS: `/health`, `POST /jobs`, `GET /jobs/<id>`. Fake GCS:
`/storage/v1/b/<bucket>/o` (list), `DELETE /storage/v1/b/<bucket>/o/<object>`.

## Final review fixes

Findings from the whole-branch review of `part2-agora-stack`, with the
evidence gathered while fixing each.

### CPLS archived `quorum` as `'0'` for every proposal

`cpls/sync_daonode.py`'s `DaoNodeSync.read_quorum` dispatches on
`infra_dao_slug`. Six of the seven branches that call `quorum(uint256)`
pass `int(proposal_id)`; the `else` branch, which every DAO without a
hand-written branch falls into (ours is `fleet`), passed the raw
`proposal_id`. DAO Node returns proposal ids as JSON strings, and
`eth_abi`'s encoder refuses a `str` for `uint256` before any RPC call
happens. The call site catches every exception and falls back to `'0'`, so
nothing failed: the archive was simply written with a quorum of zero.

From `docker compose logs cpls`, before the fix:

```
Failed to read quorum for proposal 1075273859849237667676504636935045130289281750552847332526566291271267448405
22 (cancelled=False): Value `'107527385984923766767650463693504513028928175055284733252656629127126744840...`
of type <class 'str'> cannot be encoded by UnsignedIntegerEncoder
Quorum set to 0
```

The archived record, before (`data/fleet/proposal_list.full.ndjson.gz`):

```
$ curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o/data%2Ffleet%2Fproposal_list.full.ndjson.gz?alt=media" \
    | gunzip -c | jq -c '{id, quorum, total_voting_power_at_start}'
{"id":"70719344765219781223949422325111121206638320504507403755309964502293377655188","quorum":"0","total_voting_power_at_start":null}
{"id":"107527385984923766767650463693504513028928175055284733252656629127126744840522","quorum":"0","total_voting_power_at_start":null}
```

and after (`infra/cpls/patches/0001-read-quorum-encodes-proposal-id-as-int.patch`
plus the timestamp-clock fix below):

```
{"id":"70719344765219781223949422325111121206638320504507403755309964502293377655188","quorum":"3000000000000000000","total_voting_power_at_start":"0"}
{"id":"107527385984923766767650463693504513028928175055284733252656629127126744840522","quorum":"3000000000000000000","total_voting_power_at_start":"0"}
```

which matches the chain: `cast call $GOVERNOR "quorum(uint256)(uint256)" $PID`
returns `3000000000000000000` (60% of a 5e18 votable supply, the deploy
config's `quorumNumerator: 6000`).

Why it matters: Agora Next reads that field as the real quorum.
`src/lib/proposals/thresholds.ts`'s `resolveArchiveThresholds` returns
`safeBigInt(proposal.quorum)` for a `dao_node`-sourced proposal, and
`src/lib/proposals/status/standard.ts` then tests
`quorumVotes >= thresholds.quorum`. With `'0'` archived, every proposal met
quorum whatever the chain said.

This is a bug for every DAO that takes that branch, not something specific
to the fleet tenant. Recorded for a possible upstream pull request (the
owner's decision, not this task's).

### `total_voting_power_at_start` stays `'0'`, and nothing here depends on it

`read_snapshot_votable_supply`'s default branch calls `votableSupply()` on
the governor. AgoraGovernor has no such function:

```
$ cast call $GOVERNOR "votableSupply()(uint256)" --rpc-url http://127.0.0.1:8545
Error: server returned an error response: error code 3: execution reverted, data: "0x"
```

so the call site's `except` sets `proposal['total_voting_power_at_start'] =
'0'`. Left as is, deliberately. For the fleet tenant the field is not read
by any status derivation: `deriveStandardStatus`'s `dao_node` arm
(`src/lib/proposals/status/standard.ts`) uses only `proposal.totals` and
`thresholds.quorum`; `resolveArchiveThresholds` does return it as
`votableSupply`, but only `status/optimistic.ts` and the HYBRID arm consume
that, and the fleet has no optimistic or hybrid proposals. Fleet proposals
are `STANDARD`, `dao_node`-sourced, so the field is inert.

### The fleet governor is timestamp-clocked; CPLS reads `start_block`/`end_block` as block numbers

AgoraGovernor V2 implements EIP-6372 with a timestamp clock:

```
$ cast call $GOVERNOR "CLOCK_MODE()(string)" --rpc-url http://127.0.0.1:8545
"mode=timestamp"
$ cast call $GOVERNOR "proposalSnapshot(uint256)(uint256)" $PID --rpc-url http://127.0.0.1:8545
1789376123
$ cast block-number --rpc-url http://127.0.0.1:8545
1593
```

so a proposal's `start_block`/`end_block`, which DAO Node reports verbatim
from the governor, are unix timestamps. CPLS treats them as block numbers
in two places, and both broke here:

1. `get_timestamp(chain_id, start_block)` for `start_blocktime` and
   `end_blocktime`. `/exact_blocktime` correctly 404s (no such block), CPLS
   falls back to `/estimated_blocktime`, and the shim extrapolated
   `latest_ts + (1789376123 - 1593) * 2` seconds: `5368128289`, a date in
   2140. Every unexecuted proposal then failed `end_blocktime < curtime`
   and `start_blocktime < curtime`, so `refresh_list` archived it as
   `PENDING`; Agora Next's `deriveStatus` independently returned `PENDING`
   from the same field (`startTime > now`). A proposal with an
   `execute_event` never reached either check, which is why the M0
   proposal looked correct and nothing else would have.
2. `contract_call_encoded(chain_id, gov, start_block, 'quorum(uint256)', ...)`
   and `contract_call_encoded(chain_id, gov, end_block + 1, 'state(uint256)', ...)`.
   Evaluated at a block that does not exist, both come back `{"result": "0x"}`
   from the shim. For quorum that is another silent `'0'`; for `state()`
   it is worse, because `refresh_list` has no `else` for an unrecognised
   stage and raises `Unhandled proposal lifecycle stage 0x for proposal_id:
   ...`, failing the whole sync job. That is the code path a Defeated
   proposal takes.

Fixed in `infra/blockcache-shim` rather than in CPLS: the shim exists
precisely because the real hosted blockcache service has no notion of this
local chain, and this is the same class of knowledge. With
`GOVERNOR_CLOCK_MODE=timestamp` (set in `infra/docker-compose.yml`,
overridable through `infra/.env`), a position past the chain head is
treated as what it is on a timestamp-clocked governor, a clock value:
`/estimated_blocktime` returns it verbatim, and `/contract_call` evaluates
at `latest`. Left at the default (`blocknumber`) the shim behaves exactly
as before.

Evaluating at `latest` is the same answer for the two calls CPLS makes
here. `quorum(proposalId)` on this governor is
`token.getPastTotalSupply(proposalSnapshot(id)) * numerator / denominator`,
and once the snapshot has elapsed none of those can change (the numerator
is only changeable by governance, which never happens on this chain).
`state(proposalId)` is asked for only after the voting period has ended and
the script has already confirmed the terminal state on-chain. Reproduced
directly against the shim before the fix:

```
$ # POST /contract_call/31337/<gov> with quorum(uint256) and the proposal id
start_block(timestamp) 1789376123 {'result': '0x'}
latest                             {'result': '0x00000000000000000000000000000000000000000000000029a2241af62c0000'}
```

(`0x29a2241af62c0000` is 3e18.)

### The negative case: a proposal the chain defeats

Everything above only diverges for a proposal that is not Executed, so
`infra/scripts/scripted-proposal.sh` now drives both outcomes (`OUTCOME=succeed`,
the default, and `OUTCOME=defeat`) and `bootstrap-local.sh` runs it twice
against two separate tasks. The negative case casts 2 For and 3 Against,
which misses the 60% For-only quorum, and asserts:

- `cast call $GOVERNOR "state(uint256)(uint8)" $PID` is `3` (Defeated);
- `ledger.exceptionVersion(taskId, payloadHash)` is `0`, so nothing was
  recorded;
- Agora Next's own status badge reads `DEFEATED`, and specifically not
  `SUCCEEDED`.

That last assertion reads one element, not the page. The proposal page
renders its status through
`vendor/agora-next/src/components/Proposals/ProposalStatus/ProposalStatusDetail.tsx`,
which tags the badge `data-testid="proposal-status-badge"`:

```
$ curl -s "http://localhost:3000/proposals/$PID" \
    | grep -o 'data-testid="proposal-status-badge"[^>]*>[^<]*'
data-testid="proposal-status-badge" class="text-red-600 bg-red-200 rounded-sm px-1 py-0.5 font-semibold">DEFEATED
```

Grepping the whole page for a status word proves nothing: "queued",
"succeeded" and "executed" each appear several times in the same HTML (the
lifecycle timeline, the vote panel, the RSC payload).

### Agora Next's For-only status arm and `FleetHook.beforeVoteSucceeded` differ only at For equal to Against

`FleetHook.beforeVoteSucceeded` is `forVotes >= governor.quorum(proposalId)
&& forVotes > againstVotes`; Agora Next's `dao_node` arm is
`forVotes + abstainVotes >= quorum` plus an explicit `if (forVotes <
againstVotes) return "DEFEATED"`. With no abstain votes the two differ only
where For equals Against, which this deployment cannot reach: quorum is
6000/10000 of a 5e18 supply, so any proposal meeting quorum has at least
3e18 For and therefore at most 2e18 Against.
