#!/usr/bin/env bash
# write-agora-next-deployment.sh: emit deployments/agora-next-deployment.json
# from the Part 1 manifest. infra/agora-next/overlay's fleet.ts
# (loadFleetDeployment) re-reads this exact file (mounted read-only at
# FLEET_DEPLOYMENT_FILE=/deployments/agora-next-deployment.json, a volume
# onto ../deployments, repo-relative to this worktree, not deployments/31337)
# on every call, so a restart is all agora-next needs after this changes.
#
# Idempotent: always rewrites the file from the current manifest.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worktree_root="$(cd "$script_dir/../.." && pwd)"

manifest="$worktree_root/deployments/31337/latest.json"
out="$worktree_root/deployments/agora-next-deployment.json"

if [ ! -f "$manifest" ]; then
  echo "write-agora-next-deployment: manifest not found at $manifest (run the contracts deploy step first)" >&2
  exit 1
fi

jq '{
  chainId: .chainId,
  governor: .addresses.governor,
  token: .addresses.token,
  timelock: .addresses.timelock,
  ledger: .addresses.ledger,
  hook: .addresses.hook,
  registry: .addresses.registry
}' "$manifest" > "$out"

echo "write-agora-next-deployment: wrote $out"
cat "$out"
