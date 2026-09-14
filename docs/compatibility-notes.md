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

### `JsonRpcRtHttpClient.read()` (the polling client) blocks the event loop; anvil + full default client mix can hang boot

`app/clients_httpjson.py` `JsonRpcRtHttpClient.read()` (line ~506) is
declared `async def` but its body (`w3.eth.block_number`,
`get_paginated_logs(...)` -> `w3.eth.get_logs(...)`) is 100% synchronous
`web3.py` calls (the default `HTTPProvider` uses blocking `requests`
under the hood) with no `await` before the first `yield`. This is
pre-existing upstream behaviour, not something any of our four patches
touch.

With the full default client mix (`NUM_REALTIME_CLIENTS=2`,
`NUM_POLLING_CLIENTS=1`, none of which we override in compose), we saw
the container hang completely on cold start twice out of five boots in
this session: TCP connect succeeded but every HTTP request timed out
forever, including from `docker exec` inside the container itself, and
the healthcheck never turned healthy. Isolation tests (varying
`NUM_REALTIME_CLIENTS`/`NUM_POLLING_CLIENTS` on ad hoc `docker run`
containers against the same anvil) showed the WS realtime client alone
and the polling client alone (whose first real poll only fires after
`POLLING_WAIT_CYCLE`, default 120s) each boot and serve fine on their
own; only the full default combination reproduced the hang, and not on
every boot. `docker compose restart dao-node` (or `up -d --build` again)
cleared it every time it was observed, and the resulting image, once
healthy, ran cleanly under repeated `/v1/progress` polling. We believe
this is a race between the two realtime WS subscriptions and the
synchronous archive/polling reads against anvil's very low-latency,
fast-block-time (`--block-time 2`) local chain, a condition upstream
almost certainly never hits against a real mainnet/L2 RPC endpoint.

We did not patch this: it's outside the three patches this task was
scoped to, the code it lives in is untouched by any of them, and a
proper fix (moving the polling client's web3 calls to
`loop.run_in_executor` or an async provider) is a real behavioural
change to upstream dao-node that deserves its own review rather than
being folded into this task silently. If Task 6 (or CI) sees
`dao-node` stuck at `health: starting` past a few healthcheck retries,
`docker compose restart dao-node` is the known workaround; consider
filing this upstream or, if it recurs often enough to block Task 6,
setting `NUM_POLLING_CLIENTS=0` in `infra/.env` for local/anvil use
(the polling client is described in its own docstring as "a backup to
the web-sockets... if everything is working, none of the events caught
in polling would ever be needed").

### Patch 0003 (`DAO_NODE_START_BLOCK`) verified with a positive and negative control

With `DAO_NODE_START_BLOCK=0` set: log shows
`Reading from client #1 of type JsonRpcHistHttpClient from block 0`
immediately, no block-search log lines. With the env var unset: log
shows `Searching for a block ~7 days ago from block 203` followed by
`No block older than 7 days found.` (anvil's chain is too young to have
any block older than 7 days) before falling back to block 0 anyway, just
after a wasted full-chain scan. Confirms the patch is both effective and
correctly gated on the env var being set.

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
