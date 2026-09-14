#!/usr/bin/env bash
# write-daonode-config.sh: turn the Part 1 deployment manifest into what DAO
# Node needs to boot against the real fleet: infra/.env's TOKEN_ADDRESS,
# GOVERNOR_ADDRESS and DAO_NODE_START_BLOCK, plus one ABI file per contract
# under infra/dao-node/abis/<lowercase address>.json (infra/dao-node's own
# load_abi() patch reads ABI_DIR + "<lowercase address>.json", see
# docs/compatibility-notes.md).
#
# Idempotent: safe to re-run against the same or a new manifest. Overwrites
# infra/.env's three keys in place (creating the file from .env.example
# first if it doesn't exist yet) and always rewrites both ABI files.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worktree_root="$(cd "$script_dir/../.." && pwd)"
# contracts/ and packages/abi/ live on main, not in this worktree (see
# docs/compatibility-notes.md and infra/README.md): resolve the shared
# repo's root via git's common dir rather than a hardcoded path, so this
# still works if the worktree is checked out somewhere else.
main_root="$(dirname "$(git -C "$worktree_root" rev-parse --path-format=absolute --git-common-dir)")"

manifest="$worktree_root/deployments/31337/latest.json"
abi_src="$main_root/packages/abi/abis"
env_file="$worktree_root/infra/.env"
env_example="$worktree_root/infra/.env.example"
abi_dest="$worktree_root/infra/dao-node/abis"

if [ ! -f "$manifest" ]; then
  echo "write-daonode-config: manifest not found at $manifest (run the contracts deploy step first)" >&2
  exit 1
fi

token_address=$(jq -r '.addresses.token' "$manifest")
governor_address=$(jq -r '.addresses.governor' "$manifest")
deployment_block=$(jq -r '.deploymentBlock' "$manifest")

for name_value in "token_address:$token_address" "governor_address:$governor_address" "deployment_block:$deployment_block"; do
  value=${name_value#*:}
  if [ -z "$value" ] || [ "$value" = "null" ]; then
    echo "write-daonode-config: manifest at $manifest is missing ${name_value%%:*}" >&2
    exit 1
  fi
done

if [ ! -f "$env_file" ]; then
  cp "$env_example" "$env_file"
fi

set_env_var() {
  local key=$1 value=$2 tmp
  if grep -q "^${key}=" "$env_file"; then
    tmp=$(mktemp)
    sed "s#^${key}=.*#${key}=${value}#" "$env_file" > "$tmp"
    mv "$tmp" "$env_file"
  else
    echo "${key}=${value}" >> "$env_file"
  fi
}

set_env_var TOKEN_ADDRESS "$token_address"
set_env_var GOVERNOR_ADDRESS "$governor_address"
set_env_var DAO_NODE_START_BLOCK "$deployment_block"

mkdir -p "$abi_dest"
token_lower=$(echo "$token_address" | tr '[:upper:]' '[:lower:]')
governor_lower=$(echo "$governor_address" | tr '[:upper:]' '[:lower:]')

# FleetVotes.sol/FleetVotes.json over the abstract ERC20Votes.sol/ERC20Votes.json
# it extends: see docs/compatibility-notes.md, Task 3, "ABI export".
jq '.' "$abi_src/FleetVotes.json" > "$abi_dest/${token_lower}.json"
jq '.' "$abi_src/AgoraGovernor.json" > "$abi_dest/${governor_lower}.json"

echo "write-daonode-config: wrote TOKEN_ADDRESS=$token_address GOVERNOR_ADDRESS=$governor_address DAO_NODE_START_BLOCK=$deployment_block to $env_file"
echo "write-daonode-config: wrote ABIs to $abi_dest/${token_lower}.json and $abi_dest/${governor_lower}.json"
