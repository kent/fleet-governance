#!/usr/bin/env bash
# bootstrap-local.sh: the one command that takes an empty local Anvil to a
# fully governed fleet with one executed proposal and one defeated one,
# both visible end to end in Agora Next. See infra/README.md for ports,
# prerequisites and what each step produces.
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
#   6. scripted-proposal.sh twice: one proposal that meets quorum and is
#      executed, one that does not and ends Defeated, each syncing CPLS
#      after its safe stages and each asserting that Agora Next's own
#      status badge agrees with the governor.
#   7. Write deployments/31337/bootstrap-status.json (addresses, both
#      proposals and their outcomes, URLs, compose files, endpoints, CPLS
#      job payload) and print both proposals' Agora Next URLs.
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
manifest="$worktree_root/deployments/31337/latest.json"

[ -f "$infra_dir/.env" ] || cp "$infra_dir/.env.example" "$infra_dir/.env"

# Read the handful of values this script itself needs out of infra/.env,
# one key at a time, into plain (never exported) shell variables. Nothing
# docker-compose.yml interpolates may enter this script's environment:
# Compose prefers the shell environment over the project's .env file, and
# step 3 below rewrites TOKEN_ADDRESS/GOVERNOR_ADDRESS/DAO_NODE_START_BLOCK
# in that file after this point. Exporting them here would pin every later
# `compose up` to whatever was in .env at startup, which on a fresh clone
# is .env.example's zero-address placeholders. See env-lib.sh's header and
# the `compose config` guard at the end of step 3.
ENV_FILE="$infra_dir/.env"
# shellcheck source=env-lib.sh
source "$script_dir/env-lib.sh"

ANVIL_PORT=$(read_env_value ANVIL_PORT 8545)
POSTGRES_PORT=$(read_env_value POSTGRES_PORT 55432)
DAO_NODE_PORT=$(read_env_value DAO_NODE_PORT 8000)
CPLS_PORT=$(read_env_value CPLS_PORT 8001)
FAKE_GCS_PORT=$(read_env_value FAKE_GCS_PORT 4443)
AGORA_NEXT_PORT=$(read_env_value AGORA_NEXT_PORT 3000)
GCS_CREDENTIALS_FILE=$(read_env_value GCS_CREDENTIALS_FILE "")
GCS_BUCKET_NAME=$(read_env_value GCS_BUCKET_NAME fleet-archive-dev)

compose_files=(-f "$infra_dir/docker-compose.yml")
# OFFLINE is exported on purpose (it is not a Compose-interpolated variable):
# scripted-proposal.sh reads it to decide whether to wait for each archive
# object on fake-gcs's JSON API or on the public storage.googleapis.com URL.
export OFFLINE
if [ -z "$GCS_CREDENTIALS_FILE" ]; then
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
mkdir -p "$(dirname "$manifest")"
mv "$tmp_manifest" "$manifest"
echo "bootstrap-local: wrote $manifest"
jq '.addresses' "$manifest"

# --- 3. Configure DAO Node and Agora Next with the real addresses ---------

echo "== [3/7] writing DAO Node config and Agora Next deployment file =="
bash "$script_dir/write-daonode-config.sh"
bash "$script_dir/write-agora-next-deployment.sh"

# Guard: everything dao-node and cpls are about to be started with comes
# from Compose's own interpolation of infra/.env, which write-daonode-config.sh
# has just rewritten. Assert that what Compose actually renders matches the
# manifest before starting anything, rather than discovering a stale
# zero-address deployment several minutes later as an empty proposal list.
# This is the check that would have caught the "script exported .env at
# startup, then rewrote the file" bug: an exported TOKEN_ADDRESS wins over
# the file, so `compose config` would still show the placeholder here.
expected_token=$(jq -r '.addresses.token' "$manifest")
expected_governor=$(jq -r '.addresses.governor' "$manifest")
rendered=$(compose config --format json)
for svc in dao-node cpls; do
  for pair in "TOKEN_ADDRESS:$expected_token" "GOVERNOR_ADDRESS:$expected_governor"; do
    key=${pair%%:*}
    expected=${pair#*:}
    actual=$(echo "$rendered" | jq -r --arg svc "$svc" --arg key "$key" '.services[$svc].environment[$key] // ""')
    if [ "$actual" != "$expected" ]; then
      echo "bootstrap-local: compose would start $svc with $key=$actual, but the manifest says $expected." >&2
      echo "bootstrap-local: Compose prefers the shell environment over $infra_dir/.env." >&2
      echo "bootstrap-local: unset $key in this shell (or stop exporting it) and re-run; aborting." >&2
      exit 1
    fi
  done
done
echo "bootstrap-local: compose config check OK:"
echo "$rendered" | jq -r '.services["dao-node"].environment | "  dao-node  TOKEN_ADDRESS=\(.TOKEN_ADDRESS) GOVERNOR_ADDRESS=\(.GOVERNOR_ADDRESS) DAO_NODE_START_BLOCK=\(.DAO_NODE_START_BLOCK)"'
echo "$rendered" | jq -r '.services["cpls"].environment | "  cpls      TOKEN_ADDRESS=\(.TOKEN_ADDRESS) GOVERNOR_ADDRESS=\(.GOVERNOR_ADDRESS)"'

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

# --- 6. Drive the scripted proposals -----------------------------------------

# Two proposals, on two tasks, through the same real governor: one that
# meets the For-only quorum and is queued and executed, and one that does
# not and ends Defeated. The negative case is the one that exercises Agora
# Next's vote-derived status (the archive's quorum and blocktimes) instead
# of a terminal on-chain event; see scripted-proposal.sh's header.
results_dir=$(mktemp -d)
trap 'rm -rf "$results_dir"' EXIT

echo "== [6/7] driving the scripted proposals through the real governor =="
echo "-- proposal 1 of 2: succeed (3 For / 2 Against, queued and executed) --"
OUTCOME=succeed PROPOSAL_RESULT_FILE="$results_dir/succeed.json" \
  bash "$script_dir/scripted-proposal.sh"
echo "-- proposal 2 of 2: defeat (2 For / 3 Against, never queued) --"
OUTCOME=defeat PROPOSAL_RESULT_FILE="$results_dir/defeat.json" \
  bash "$script_dir/scripted-proposal.sh"

for f in "$results_dir/succeed.json" "$results_dir/defeat.json"; do
  if [ ! -s "$f" ]; then
    echo "bootstrap-local: scripted-proposal.sh did not write $f; aborting" >&2
    exit 1
  fi
done

executed_id=$(jq -r '.proposal_id' "$results_dir/succeed.json")
defeated_id=$(jq -r '.proposal_id' "$results_dir/defeat.json")

# --- 7. Write the handoff and print the result ------------------------------

# One machine-readable record of everything this run produced, next to the
# deployment manifest it belongs to: what was deployed, which compose files
# and endpoints were used, what each proposal did, and the exact CPLS job
# payload a sync posts. Anything downstream (a reviewer, a later script, a
# report) reads this instead of parsing log lines.
status_file="$(dirname "$manifest")/bootstrap-status.json"
jq -n \
  --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg manifest "${manifest#"$worktree_root/"}" \
  --argjson offline "$([ "$OFFLINE" = "1" ] && echo true || echo false)" \
  --argjson compose_files "$(printf '%s\n' "${compose_files[@]}" | grep -v '^-f$' | sed "s#^$worktree_root/##" | jq -R . | jq -s .)" \
  --slurpfile manifest_json "$manifest" \
  --slurpfile succeeded "$results_dir/succeed.json" \
  --slurpfile defeated "$results_dir/defeat.json" \
  --arg anvil "http://localhost:$ANVIL_PORT" \
  --arg postgres "postgres://agora:agora@localhost:$POSTGRES_PORT/agora_web3" \
  --arg dao_node "http://localhost:$DAO_NODE_PORT" \
  --arg cpls "http://localhost:$CPLS_PORT" \
  --arg fake_gcs "http://localhost:$FAKE_GCS_PORT" \
  --arg agora_next "http://localhost:$AGORA_NEXT_PORT" \
  '{
     generated_at: $generated_at,
     manifest: $manifest,
     chain_id: $manifest_json[0].chainId,
     deployment_block: $manifest_json[0].deploymentBlock,
     addresses: $manifest_json[0].addresses,
     offline: $offline,
     compose_files: $compose_files,
     endpoints: {
       anvil: $anvil,
       postgres: $postgres,
       dao_node: $dao_node,
       cpls: $cpls,
       fake_gcs: (if $offline then $fake_gcs else null end),
       agora_next: $agora_next
     },
     readiness_waited_on: [
       ($anvil + " (cast chain-id)"),
       "postgres (compose healthcheck)",
       ($dao_node + "/v1/progress"),
       ($cpls + "/health"),
       ($agora_next + "/proposals")
     ],
     cpls_job_payload: $succeeded[0].cpls_job_payload,
     proposals: [
       ($succeeded[0] | del(.cpls_job_payload)),
       ($defeated[0] | del(.cpls_job_payload))
     ]
   }' > "$status_file"

echo "== [7/7] done =="
cat "$status_file"
echo "bootstrap-local: wrote $status_file"
echo "bootstrap-local: executed proposal $executed_id"
echo "bootstrap-local:   http://localhost:$AGORA_NEXT_PORT/proposals/$executed_id"
echo "bootstrap-local: defeated proposal $defeated_id"
echo "bootstrap-local:   http://localhost:$AGORA_NEXT_PORT/proposals/$defeated_id"
