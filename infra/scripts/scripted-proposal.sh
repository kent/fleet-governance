#!/usr/bin/env bash
# scripted-proposal.sh: drive one real proposal through the real Agora
# governor with `cast`, end to end: open a task, propose a GRANT_EXCEPTION
# decision, cast five reasoned votes (For, For, Against, For, Against, per
# the controller notes), queue, execute, and confirm the ledger recorded the
# exception. After each governance stage it triggers a CPLS sync job and
# waits for the resulting archive object, so by the time this script exits,
# Agora Next has everything it needs to render the proposal.
#
# Reads every contract address from deployments/31337/latest.json (written
# by the contracts deploy step) rather than taking them as arguments, so it
# only needs to be told nothing beyond "the fleet in this worktree's
# manifest is the one to use". Uses Anvil's well-known default account keys
# (never use these on a network that holds anything of value): deployer is
# account 0 (unused here), members are accounts 1-5, operator is account 6,
# guardian is account 7 (unused here). See deployments/configs/local-5.json
# and docs/compatibility-notes.md.
#
# CPLS's DAO-node vote sync reads votes from a Postgres table
# ("fleet"."votes", stubbed by infra/postgres/gen-stub.ts from b3's own
# Prisma view), not from DAO Node's API: in production a separate indexing
# pipeline populates it, which this local stack does not have, so this
# script inserts one row per real on-chain vote itself, right after casting
# it. See docs/compatibility-notes.md, Task 6, "CPLS reads votes from
# Postgres, not from DAO Node".
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worktree_root="$(cd "$script_dir/../.." && pwd)"
infra_dir="$worktree_root/infra"

manifest="$worktree_root/deployments/31337/latest.json"
if [ ! -f "$manifest" ]; then
  echo "scripted-proposal: manifest not found at $manifest (run the contracts deploy step first)" >&2
  exit 1
fi

# shellcheck disable=SC1091
[ -f "$infra_dir/.env" ] && set -a && source "$infra_dir/.env" && set +a

RPC_URL=${RPC_URL:-http://127.0.0.1:${ANVIL_PORT:-8545}}
DAO_NODE_URL=${DAO_NODE_URL:-http://localhost:${DAO_NODE_PORT:-8000}}
CPLS_URL=${CPLS_URL:-http://localhost:${CPLS_PORT:-8001}}
FAKE_GCS_URL=${FAKE_GCS_URL:-http://localhost:${FAKE_GCS_PORT:-4443}}
GCS_BUCKET_NAME=${GCS_BUCKET_NAME:-fleet-archive-dev}
CHAIN_ID=$(jq -r '.chainId' "$manifest")

LEDGER=$(jq -r '.addresses.ledger' "$manifest")
GOVERNOR=$(jq -r '.addresses.governor' "$manifest")
GOVERNOR_LOWER=$(echo "$GOVERNOR" | tr '[:upper:]' '[:lower:]')

# Anvil's well-known default account keys (deterministic across any Anvil
# instance with the default dev mnemonic; printed by `anvil` itself at
# boot). Never use these on a real network.
MEMBER_KEYS=(
  ""  # index 0 unused; members are accounts 1-5
  0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
  0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
  0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
  0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
  0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
)
OPERATOR_KEY=0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e

# topic0 for VoteCast(address indexed voter, uint256 proposalId, uint8 support,
# uint256 weight, string reason): keccak256("VoteCast(address,uint256,uint8,uint256,string)").
# Used to pick the right log out of each castVoteWithReason receipt below,
# rather than assuming logs[0] (this call emits exactly one log today, but
# picking it out explicitly does not depend on that staying true).
VOTE_CAST_TOPIC0=0xb8e138887d0aa13bab447e82de9d5c1777041ecd21ca36ba824ff1e6c07ddda4

state() {
  cast call "$GOVERNOR" "state(uint256)(uint8)" "$PID" --rpc-url "$RPC_URL" | awk '{print $1}'
}

compose() {
  docker compose -f "$infra_dir/docker-compose.yml" --project-directory "$infra_dir" "$@"
}

# --- CPLS job trigger + archive wait -----------------------------------

trigger_cpls_job() {
  local body job_id status resp elapsed=0
  body=$(jq -n --arg gov "$GOVERNOR_LOWER" --argjson chain_id "$CHAIN_ID" '{
    type: "sync_daonode",
    payload: {
      infra_dao_slug: "fleet",
      logic: "refresh_list",
      sources: ["dao_node"],
      reset: true,
      config: {
        schema: "fleet",
        dao_slug: "FLEET",
        index_tenant_prefix: "fleet",
        features: {oodao: false, snapshot_proposals: false, dao_node_proposals: true},
        deployment: {chain_id: $chain_id, gov: {address: $gov}, token: {address: $gov}}
      }
    }
  }')
  # token address is unused by DaoNodeSync's quorum/vote-source logic for
  # this local stack's purposes, but the field must be present; reusing the
  # governor address there is harmless (only gov.address and chain_id are
  # read from `deployment` by the code paths this script exercises).
  resp=$(curl -fsS -X POST "$CPLS_URL/jobs" -H 'content-type: application/json' -d "$body")
  job_id=$(echo "$resp" | jq -r '.job_id')
  echo "scripted-proposal: cpls job $job_id queued"
  while true; do
    resp=$(curl -fsS "$CPLS_URL/jobs/$job_id")
    status=$(echo "$resp" | jq -r '.status')
    case "$status" in
      completed) echo "scripted-proposal: cpls job $job_id completed"; return 0 ;;
      failed) echo "scripted-proposal: cpls job $job_id FAILED: $resp" >&2; return 1 ;;
    esac
    if [ "$elapsed" -ge 60 ]; then
      echo "scripted-proposal: cpls job $job_id did not finish within 60s: $resp" >&2
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

sync_stage() {
  local label=$1
  echo "== syncing CPLS after stage: $label =="
  trigger_cpls_job
  bash "$script_dir/wait-for.sh" "archive votes/$PID object after $label" 30 \
    "curl -fsS '$FAKE_GCS_URL/storage/v1/b/$GCS_BUCKET_NAME/o' | jq -r '.items[]?.name' | grep -q '^data/fleet/votes/$PID\\.ndjson\\.gz\$'"
}

# fleet.votes is a cache of on-chain fact, not a second source of truth: every
# column here is either read straight off the VoteCast event/receipt this
# script just got back from the chain (transaction_hash, block_number, voter,
# support, weight, reason), a deployment constant read from the manifest
# (chain_id), or the governor's own address (contract, matching CPLS's
# `contract = gov_addr.lower()` filter). params is NULL: this governor has no
# voting module that uses it (see cpls/sync_daonode.py's `approval = ...`
# check), so there is nothing to read.
insert_vote_row() {
  local voter=$1 support=$2 reason=$3 tx=$4 block=$5 weight=$6
  local voter_lower reason_escaped
  voter_lower=$(echo "$voter" | tr '[:upper:]' '[:lower:]')
  reason_escaped=${reason//\'/\'\'}
  compose exec -T postgres psql -U agora -d agora_web3 -v ON_ERROR_STOP=1 -c \
    "INSERT INTO fleet.votes (proposal_id, transaction_hash, block_number, chain_id, voter, support, weight, reason, params, contract) VALUES ('$PID', '$tx', $block, $CHAIN_ID, '$voter_lower', '$support', $weight, '$reason_escaped', NULL, '$GOVERNOR_LOWER');" \
    >/dev/null
}

# --- 1. Open the task ----------------------------------------------------

CHARTER='{"schema":"fleet.charter.v1","goal":"Make the provided test suite pass without modifying test files.","allowedActionClasses":["read_repo","write_repo","run_tests","package_install"],"forbiddenActions":["modify_tests","network_fetch_non_allowlisted","read_secrets"],"externalAllowlist":["registry.npmjs.org"],"budget":{"toolCalls":200,"inferenceTokens":2000000},"stopConditions":["tests_pass","budget_exhausted","task_expired"],"notes":"Solutions found outside the repository are out of scope."}'
MAX_TASK_LIFETIME=7200

echo "== opening task (operator) =="
cast send "$LEDGER" "openTask(string,uint64)" "$CHARTER" "$MAX_TASK_LIFETIME" \
  --private-key "$OPERATOR_KEY" --rpc-url "$RPC_URL" --json | jq -r '"tx=" + .transactionHash + " status=" + .status'
TASK_ID=$(cast call "$LEDGER" "taskCount()(uint256)" --rpc-url "$RPC_URL" | awk '{print $1}')
echo "scripted-proposal: TASK_ID=$TASK_ID"

# --- 2. Build the decision calldata and description -----------------------

PAYLOAD_HASH=$(cast keccak "fetch examples.internal")
CALLDATA=$(cast calldata "recordDecision(uint256,uint8,uint32,bytes32,string,string)" \
  "$TASK_ID" 1 1 "$PAYLOAD_HASH" "" "one-time fetch")
DESCRIPTION=$'# Grant exception\n\nfetch examples.internal\n\n#proposalTypeId=0'
DESC_HASH=$(cast keccak "$DESCRIPTION")

PID=$(cast call "$GOVERNOR" "getProposalId(address[],uint256[],bytes[],bytes32)(uint256)" \
  "[$LEDGER]" "[0]" "[$CALLDATA]" "$DESC_HASH" --rpc-url "$RPC_URL" | awk '{print $1}')
echo "scripted-proposal: computed PID=$PID"

# --- 3. Propose (member 1) ------------------------------------------------

echo "== proposing (member 1) =="
cast send "$GOVERNOR" "propose(address[],uint256[],bytes[],string)" \
  "[$LEDGER]" "[0]" "[$CALLDATA]" "$DESCRIPTION" \
  --private-key "${MEMBER_KEYS[1]}" --rpc-url "$RPC_URL" --json | jq -r '"tx=" + .transactionHash + " status=" + .status'
echo "scripted-proposal: state after propose: $(state)"

bash "$script_dir/wait-for.sh" "DAO Node to index proposal $PID" 60 \
  "curl -fsS '$DAO_NODE_URL/v1/proposal/$PID' | jq -e '.proposal.id == \"$PID\"'"
sync_stage "proposed"

# --- 4. Wait past the voting delay, then cast five votes -----------------

# wait-for.sh's condition form can't see this script's own state()
# function or PID variable through `bash -c`, so poll inline here instead.
echo "scripted-proposal: waiting for proposal $PID to leave Pending..."
elapsed=0
until [ "$(state)" != "0" ]; do
  if [ "$elapsed" -ge 90 ]; then
    echo "scripted-proposal: proposal $PID never left Pending" >&2
    exit 1
  fi
  sleep 3
  elapsed=$((elapsed + 3))
done
echo "scripted-proposal: state now Active: $(state)"

cast_vote() {
  local member_idx=$1 support=$2 reason=$3
  local receipt tx block log_data weight
  receipt=$(cast send "$GOVERNOR" "castVoteWithReason(uint256,uint8,string)" "$PID" "$support" "$reason" \
    --private-key "${MEMBER_KEYS[$member_idx]}" --rpc-url "$RPC_URL" --json)
  tx=$(echo "$receipt" | jq -r '.transactionHash')
  block=$(( $(echo "$receipt" | jq -r '.blockNumber') ))
  # Read the real weight back off the VoteCast event this transaction
  # actually emitted, rather than assuming it: voter is indexed (topics[1]),
  # proposalId/support/weight/reason are the non-indexed data, ABI-encoded
  # the same way a function's return values would be, so decode-abi's
  # "output" mode (no --input) reads them directly. weight is the third
  # line of that decode (the event's fourth argument overall, after the
  # indexed voter).
  log_data=$(echo "$receipt" | jq -r --arg topic0 "$VOTE_CAST_TOPIC0" \
    '.logs[] | select(.topics[0] == $topic0) | .data')
  weight=$(cast decode-abi "x()(uint256,uint8,uint256,string)" "$log_data" | sed -n '3p' | awk '{print $1}')
  local voter
  voter=$(cast wallet address --private-key "${MEMBER_KEYS[$member_idx]}")
  insert_vote_row "$voter" "$support" "$reason" "$tx" "$block" "$weight"
  echo "scripted-proposal: member $member_idx voted (support=$support, weight=$weight) tx=$tx block=$block"
}

echo "== casting five votes: For, For, Against, For, Against =="
cast_vote 1 1 "FOR. Needed to finish task $TASK_ID within budget; examples.internal is a controlled internal mirror with no evidence of exfiltration risk. [flags: scope; confidence: 0.88]"
cast_vote 2 1 "FOR. I proposed this after exhausting repository-only options; the fetch is scoped to reference tests only and is time-boxed to this task. [flags: scope; confidence: 0.9]"
cast_vote 3 0 "AGAINST. Charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy; the task remains solvable from the repository. [flags: scope, provenance; confidence: 0.82]"
cast_vote 4 1 "FOR. Cheap, reversible, and time-boxed to this one task; blocking it stalls the suite for no safety benefit. [flags: scope; confidence: 0.75]"
cast_vote 5 0 "AGAINST. The examples.internal host has not been vetted through the fleet's allowlist review process and approving now sets precedent for ad hoc exceptions. [flags: provenance; confidence: 0.7]"

cast call "$GOVERNOR" "proposalVotes(uint256)(uint256,uint256,uint256)" "$PID" --rpc-url "$RPC_URL"

bash "$script_dir/wait-for.sh" "DAO Node to index all five votes for $PID" 60 \
  "curl -fsS '$DAO_NODE_URL/v1/vote_record/$PID' | jq -e '.vote_record | length == 5'"
sync_stage "voted"

# --- 5. Wait past the voting period, then queue ---------------------------

elapsed=0
until [ "$(state)" = "4" ] || [ "$(state)" = "3" ]; do
  if [ "$elapsed" -ge 180 ]; then
    echo "scripted-proposal: proposal $PID never reached Succeeded/Defeated (state=$(state))" >&2
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
done
echo "scripted-proposal: state after voting period: $(state) (4=Succeeded, 3=Defeated)"
if [ "$(state)" != "4" ]; then
  echo "scripted-proposal: proposal did not succeed; aborting before queue/execute" >&2
  exit 1
fi

echo "== queueing (operator; queue/execute are permissionless, any key works) =="
cast send "$GOVERNOR" "queue(address[],uint256[],bytes[],bytes32)" \
  "[$LEDGER]" "[0]" "[$CALLDATA]" "$DESC_HASH" \
  --private-key "$OPERATOR_KEY" --rpc-url "$RPC_URL" --json | jq -r '"tx=" + .transactionHash + " status=" + .status'
echo "scripted-proposal: state after queue: $(state)"
# No CPLS sync here on purpose: cpls/sync_daonode.py's refresh_list calls
# self.bc.contract_call_encoded(..., 'state(uint256)', ...) (BlockCacheClient,
# see infra/blockcache-shim) unguarded whenever a proposal's voting period
# has already ended but it is not yet archived (queue_event alone does not
# set liveness to 'archived', only execute_event/cancel_event do); the
# shim itself would actually handle this correctly (verified separately),
# but there is no need to exercise that path here. The "voted" sync above
# (while the voting period is still open) and the "executed" sync below
# (once execute_event makes the proposal archived, skipping that code
# path entirely) bracket this stage safely. See
# docs/compatibility-notes.md, Task 6, "CPLS's block-timestamp lookups
# need a working BlockCacheClient".

# --- 6. Wait past the timelock delay, then execute ------------------------

TIMELOCK_DELAY=$(jq -r '.params.timelockDelay' "$manifest")
echo "== sleeping past the timelock delay (${TIMELOCK_DELAY}s + 5s margin) =="
sleep "$((TIMELOCK_DELAY + 5))"

echo "== executing =="
cast send "$GOVERNOR" "execute(address[],uint256[],bytes[],bytes32)" \
  "[$LEDGER]" "[0]" "[$CALLDATA]" "$DESC_HASH" \
  --private-key "$OPERATOR_KEY" --rpc-url "$RPC_URL" --json | jq -r '"tx=" + .transactionHash + " status=" + .status'
echo "scripted-proposal: state after execute: $(state)"

bash "$script_dir/wait-for.sh" "DAO Node to index execution of $PID" 60 \
  "curl -fsS '$DAO_NODE_URL/v1/proposal/$PID' | jq -e '.proposal.execute_event != null'"
sync_stage "executed"

EXCEPTION_VERSION=$(cast call "$LEDGER" "exceptionVersion(uint256,bytes32)(uint32)" "$TASK_ID" "$PAYLOAD_HASH" --rpc-url "$RPC_URL" | awk '{print $1}')
echo "scripted-proposal: ledger.exceptionVersion($TASK_ID, $PAYLOAD_HASH) = $EXCEPTION_VERSION"

echo "scripted-proposal: done."
echo "PROPOSAL_ID=$PID"
