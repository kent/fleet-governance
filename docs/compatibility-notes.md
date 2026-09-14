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
