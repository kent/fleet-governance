#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
forge build --silent
out=../packages/abi/abis
mkdir -p "$out"
for c in FleetRegistry FleetVotes FleetHook TaskLedger FleetExecutor GovernedArtifactStore; do
  jq '.abi' "out/$c.sol/$c.json" > "$out/$c.json"
done
jq '.abi' out/AgoraGovernor.sol/AgoraGovernor.json > "$out/AgoraGovernor.json"
jq '.abi' out/TimelockController.sol/TimelockController.json > "$out/TimelockController.json"
echo "ABIs written to $out"
ls -la "$out"
