#!/usr/bin/env bash
# bootstrap-local.sh: the one command that takes an empty local Anvil to a
# fully governed fleet with one executed proposal, visible end to end in
# Agora Next. See infra/README.md for ports, prerequisites and what each
# step produces.
#
# Order (matches the Part 2 spec's end-to-end lifecycle, section 9):
#   0. Build every service's image once, up front (see the comment at that
#      step for why this has to happen before anything is started, and
#      why nothing after this point may pass --build to `compose up` again).
#   1. docker compose up anvil, postgres (no --build); wait for both healthy.
#   2. Deploy the fleet contracts (from the contracts/ checkout on main,
#      read-only; see write-daonode-config.sh's header for why).
#   3. write-daonode-config.sh, write-agora-next-deployment.sh.
#   4. docker compose up dao-node, cpls, agora-next, blockcache-shim (plus
#      fake-gcs, offline only), no --build; wait for each service's own
#      readiness endpoint.
#   5. Create the fake GCS bucket (offline only).
#   6. scripted-proposal.sh: drive one proposal through the real governor
#      and sync CPLS after each safe stage.
#   7. Print the proposal's Agora Next URL.
#
# Safe to re-run against an already-running stack (docker compose recreates
# only what changed); NOT idempotent against contracts already deployed on
# the same Anvil instance, by design (see spec section 9 step 1: it always
# deploys a fresh fleet). Start from a genuinely empty Anvil with
# `docker compose down -v` first (also required whenever a Postgres stub
# table changes, since compose only runs init scripts on a fresh volume).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worktree_root="$(cd "$script_dir/../.." && pwd)"
infra_dir="$worktree_root/infra"
main_root="$(dirname "$(git -C "$worktree_root" rev-parse --path-format=absolute --git-common-dir)")"
contracts_dir="$main_root/contracts"

[ -f "$infra_dir/.env" ] || cp "$infra_dir/.env.example" "$infra_dir/.env"
# shellcheck disable=SC1091
set -a && source "$infra_dir/.env" && set +a

compose_files=(-f "$infra_dir/docker-compose.yml")
if [ -z "${GCS_CREDENTIALS_FILE:-}" ]; then
  echo "bootstrap-local: GCS_CREDENTIALS_FILE unset; using the offline fake-gcs overlay."
  compose_files+=(-f "$infra_dir/docker-compose.offline.yml")
  OFFLINE=1
else
  echo "bootstrap-local: GCS_CREDENTIALS_FILE set; targeting real GCS."
  OFFLINE=0
fi

compose() {
  docker compose "${compose_files[@]}" --project-directory "$infra_dir" "$@"
}

ANVIL_PORT=${ANVIL_PORT:-8545}
DAO_NODE_PORT=${DAO_NODE_PORT:-8000}
CPLS_PORT=${CPLS_PORT:-8001}
AGORA_NEXT_PORT=${AGORA_NEXT_PORT:-3000}
FAKE_GCS_PORT=${FAKE_GCS_PORT:-4443}
GCS_BUCKET_NAME=${GCS_BUCKET_NAME:-fleet-archive-dev}

# --- 0. Build every image once, up front ------------------------------------

# Every service's Dockerfile shares one build context (`context: ..`, this
# whole worktree), so `docker compose up --build <subset>` re-evaluates the
# build for every service in the resolved dependency graph, not just the
# ones named: an anvil image rebuilt from a 100% cache hit still gets a new
# image ID (build metadata/timestamps differ), which then makes Compose
# recreate the already-running anvil CONTAINER to match it, wiping its
# in-memory chain state (anvil has no volume, unlike postgres) mid-script.
# Building every image exactly once here, before anything is started, and
# never passing --build to `compose up` again for the rest of this script,
# avoids that entirely: no image changes after this point, so nothing gets
# recreated to "match" a new image later. See docs/compatibility-notes.md,
# Task 6, "docker compose up --build recreates Anvil out from under a
# deployed fleet".
echo "== [0/7] building images =="
compose build anvil dao-node cpls agora-next blockcache-shim

# --- 1. Anvil and Postgres -------------------------------------------------

echo "== [1/7] bringing up anvil and postgres =="
compose up -d anvil postgres
bash "$script_dir/wait-for.sh" "anvil chain id" 60 "cast chain-id --rpc-url http://127.0.0.1:$ANVIL_PORT"
# wait-for.sh's condition runs in its own `bash -c`, which does not inherit
# this script's compose() function, so spell the command out in full here.
compose_files_joined="${compose_files[*]}"
bash "$script_dir/wait-for.sh" "postgres healthy" 60 \
  "[ \"\$(docker compose $compose_files_joined --project-directory '$infra_dir' ps --format '{{.Health}}' postgres 2>/dev/null)\" = healthy ]"

# --- 2. Deploy the fleet contracts -----------------------------------------

echo "== [2/7] deploying the fleet contracts (contracts/ on main, read-only) =="
# forge script's fs_permissions (contracts/foundry.toml, on main, read-only)
# only allow writes under contracts/ itself and ../deployments (main's own
# deployments/, not this worktree's): neither reaches into
# .worktrees/part2, so FLEET_MANIFEST_OUT is pointed at a scratch file
# inside contracts/ (the same class of gitignored build artifact
# `broadcast/`/`cache/` already are for any forge run there) and the result
# is copied into this worktree's deployments/31337/latest.json, then the
# scratch file is removed. contracts/ itself is never otherwise modified.
# See docs/compatibility-notes.md, Task 6, "forge script cannot write
# straight into the worktree".
tmp_manifest="$contracts_dir/.fleet-manifest-tmp.json"
rm -f "$tmp_manifest"
(
  cd "$contracts_dir"
  FLEET_DEPLOY_CONFIG=../deployments/configs/local-5.json \
  FLEET_DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  FLEET_MANIFEST_OUT="$tmp_manifest" \
  forge script script/DeployFleet.s.sol --rpc-url "http://127.0.0.1:$ANVIL_PORT" --broadcast
)
mkdir -p "$worktree_root/deployments/31337"
mv "$tmp_manifest" "$worktree_root/deployments/31337/latest.json"
echo "bootstrap-local: wrote $worktree_root/deployments/31337/latest.json"
jq '.addresses' "$worktree_root/deployments/31337/latest.json"

# --- 3. Configure DAO Node and Agora Next with the real addresses ---------

echo "== [3/7] writing DAO Node config and Agora Next deployment file =="
bash "$script_dir/write-daonode-config.sh"
bash "$script_dir/write-agora-next-deployment.sh"

# --- 4. Bring up the read side ---------------------------------------------

echo "== [4/7] bringing up dao-node, cpls, agora-next =="
if [ "$OFFLINE" = "1" ]; then
  compose up -d dao-node cpls agora-next blockcache-shim fake-gcs
else
  compose up -d dao-node cpls agora-next blockcache-shim
fi

bash "$script_dir/wait-for.sh" "DAO Node /v1/progress" 60 "curl -fsS http://localhost:$DAO_NODE_PORT/v1/progress"
bash "$script_dir/wait-for.sh" "CPLS /health" 60 "curl -fsS http://localhost:$CPLS_PORT/health"
bash "$script_dir/wait-for.sh" "Agora Next /proposals" 150 "curl -fsS http://localhost:$AGORA_NEXT_PORT/proposals"

if [ "$OFFLINE" = "1" ]; then
  echo "== [5/7] creating the fake GCS bucket =="
  GCS_BUCKET_NAME="$GCS_BUCKET_NAME" FAKE_GCS_HOST="http://localhost:$FAKE_GCS_PORT" \
    bash "$script_dir/create-fake-bucket.sh"
else
  echo "== [5/7] real GCS bucket in use; skipping fake-gcs bucket creation =="
fi

# --- 6. Drive the scripted proposal -----------------------------------------

echo "== [6/7] driving the scripted proposal through the real governor =="
proposal_output=$(bash "$script_dir/scripted-proposal.sh" 2>&1 | tee /dev/stderr)
proposal_id=$(echo "$proposal_output" | grep '^PROPOSAL_ID=' | tail -n1 | cut -d= -f2)

if [ -z "$proposal_id" ]; then
  echo "bootstrap-local: scripted-proposal.sh did not report a PROPOSAL_ID; aborting" >&2
  exit 1
fi

# --- 7. Print the result ----------------------------------------------------

echo "== [7/7] done =="
echo "bootstrap-local: proposal $proposal_id executed."
echo "bootstrap-local: Agora Next: http://localhost:$AGORA_NEXT_PORT/proposals/$proposal_id"
