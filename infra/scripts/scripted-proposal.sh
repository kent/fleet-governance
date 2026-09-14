#!/usr/bin/env bash
# scripted-proposal.sh: drive one real proposal through the real Agora
# governor with `cast`, end to end: open a task, propose a GRANT_EXCEPTION
# decision, cast five reasoned votes, and take the proposal to its terminal
# state. After each governance stage it triggers a CPLS sync job and waits
# for the resulting archive object, so by the time this script exits, Agora
# Next has everything it needs to render the proposal. It finishes by
# asserting that the Agora Next proposal page's own status badge agrees
# with the governor's `state()`.
#
# OUTCOME (env, default "succeed") picks which outcome to drive:
#
#   succeed  3 For / 2 Against (the controller notes' M0 lifecycle). Meets
#            the 60% For-only quorum, so the governor reports Succeeded;
#            the script queues, waits out the timelock, executes, and
#            confirms the ledger recorded the exception. Agora Next must
#            show EXECUTED.
#   defeat   2 For / 3 Against on its own task. 2 of 5 votes is below the
#            60% For-only quorum, so the governor reports Defeated; nothing
#            is queued or executed and the ledger must record no exception.
#            Agora Next must show DEFEATED, and specifically not SUCCEEDED:
#            that is the case that diverged while CPLS archived quorum as
#            '0' (see docs/compatibility-notes.md, "Final review fixes").
#
# The two outcomes use different task ids and different descriptions, so
# they compute different proposal ids and both can run against one chain.
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

# Read the ports out of infra/.env one key at a time, never exported: this
# script runs `docker compose exec`, which interpolates docker-compose.yml
# the same way `up` does, and an exported TOKEN_ADDRESS/GOVERNOR_ADDRESS
# from a stale .env read would take precedence over the file Compose reads
# itself. See infra/scripts/env-lib.sh's header.
ENV_FILE="$infra_dir/.env"
# shellcheck source=env-lib.sh
source "$script_dir/env-lib.sh"

RPC_URL=${RPC_URL:-http://127.0.0.1:$(read_env_value ANVIL_PORT 8545)}
DAO_NODE_URL=${DAO_NODE_URL:-http://localhost:$(read_env_value DAO_NODE_PORT 8000)}
CPLS_URL=${CPLS_URL:-http://localhost:$(read_env_value CPLS_PORT 8001)}
AGORA_NEXT_URL=${AGORA_NEXT_URL:-http://localhost:$(read_env_value AGORA_NEXT_PORT 3000)}
FAKE_GCS_URL=${FAKE_GCS_URL:-http://localhost:$(read_env_value FAKE_GCS_PORT 4443)}
GCS_BUCKET_NAME=${GCS_BUCKET_NAME:-$(read_env_value GCS_BUCKET_NAME fleet-archive-dev)}
CHAIN_ID=$(jq -r '.chainId' "$manifest")

# Whether the archive store is the offline fake-gcs container or real GCS.
# bootstrap-local.sh exports OFFLINE; run on its own, this script decides it
# the same way bootstrap-local.sh does, from GCS_CREDENTIALS_FILE.
if [ -z "${OFFLINE:-}" ]; then
  if [ -z "$(read_env_value GCS_CREDENTIALS_FILE "")" ]; then
    OFFLINE=1
  else
    OFFLINE=0
  fi
fi

OUTCOME=${OUTCOME:-succeed}
case "$OUTCOME" in
  succeed|defeat) ;;
  *)
    echo "scripted-proposal: OUTCOME must be 'succeed' or 'defeat', got '$OUTCOME'" >&2
    exit 2
    ;;
esac
echo "scripted-proposal: driving the '$OUTCOME' outcome"

# Optional: a path to write this run's machine-readable result to (ids,
# outcome, final on-chain state, the tally, the Agora Next status badge).
# bootstrap-local.sh passes one and folds it into
# deployments/31337/bootstrap-status.json, so nothing has to scrape ids
# back out of this script's log.
PROPOSAL_RESULT_FILE=${PROPOSAL_RESULT_FILE:-}

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

# The one job payload every sync posts. Built once, up front, so the
# machine-readable result file below can report it verbatim rather than
# describing it: it is the single thing a reader needs to reproduce a sync
# by hand. token address is unused by DaoNodeSync's quorum/vote-source logic
# for this local stack's purposes, but the field must be present; reusing
# the governor address there is harmless (only gov.address and chain_id are
# read from `deployment` by the code paths this script exercises).
CPLS_JOB_BODY=$(jq -n --arg gov "$GOVERNOR_LOWER" --argjson chain_id "$CHAIN_ID" '{
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

trigger_cpls_job() {
  local job_id status resp elapsed=0
  resp=$(curl -fsS -X POST "$CPLS_URL/jobs" -H 'content-type: application/json' -d "$CPLS_JOB_BODY")
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

# Waits for the archive object CPLS has just written, which is how this
# script knows a sync really landed rather than merely reporting completed.
# Offline that means the fake-gcs JSON API (its object listing); against
# real GCS it means the public object URL Agora Next itself reads, since
# fake-gcs is not running at all then. Same bounded timeout either way.
# Without this split the real-GCS path waited on a fake-gcs URL nothing was
# listening on and timed out every time.
sync_stage() {
  local label=$1 object="data/fleet/votes/$PID.ndjson.gz"
  echo "== syncing CPLS after stage: $label =="
  trigger_cpls_job
  if [ "$OFFLINE" = "1" ]; then
    bash "$script_dir/wait-for.sh" "archive $object after $label (fake-gcs)" 30 \
      "curl -fsS '$FAKE_GCS_URL/storage/v1/b/$GCS_BUCKET_NAME/o' | jq -r '.items[]?.name' | grep -q '^data/fleet/votes/$PID\\.ndjson\\.gz\$'"
  else
    bash "$script_dir/wait-for.sh" "archive $object after $label (real GCS)" 30 \
      "curl -fsI 'https://storage.googleapis.com/$GCS_BUCKET_NAME/$object'"
  fi
}

# fleet.votes is a cache of on-chain fact, not a second source of truth: every
# column here is either read straight off the VoteCast event/receipt this
# script just got back from the chain (transaction_hash, block_number, voter,
# support, weight, reason), a deployment constant read from the manifest
# (chain_id), or the governor's own address (contract, matching CPLS's
# `contract = gov_addr.lower()` filter). params is NULL: this governor has no
# voting module that uses it (see cpls/sync_daonode.py's `approval = ...`
# check), so there is nothing to read.
#
# ON CONFLICT DO NOTHING against the unique index on
# (contract, proposal_id, voter) in infra/postgres/init/04-fleet-indexes.sql:
# a second bootstrap run against a surviving Postgres volume recomputes the
# same proposal ids (the deploy is deterministic on a fresh Anvil) and would
# otherwise insert a second copy of every vote, which CPLS would count and
# archive. One vote per voter per proposal is the governor's own rule.
insert_vote_row() {
  local voter=$1 support=$2 reason=$3 tx=$4 block=$5 weight=$6
  local voter_lower reason_escaped
  voter_lower=$(echo "$voter" | tr '[:upper:]' '[:lower:]')
  reason_escaped=${reason//\'/\'\'}
  compose exec -T postgres psql -U agora -d agora_web3 -v ON_ERROR_STOP=1 -c \
    "INSERT INTO fleet.votes (proposal_id, transaction_hash, block_number, chain_id, voter, support, weight, reason, params, contract) VALUES ('$PID', '$tx', $block, $CHAIN_ID, '$voter_lower', '$support', $weight, '$reason_escaped', NULL, '$GOVERNOR_LOWER') ON CONFLICT DO NOTHING;" \
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
# The trailing "#proposalTypeId=0" marker is required: DAO Node parses the
# proposal type out of the description, and patch 0002 only tolerates its
# absence, it does not invent a type. Both outcomes carry it.
if [ "$OUTCOME" = "succeed" ]; then
  DESCRIPTION=$'# Grant exception\n\nfetch examples.internal\n\n#proposalTypeId=0'
else
  DESCRIPTION=$'# Grant exception (negative case)\n\nfetch examples.internal\n\n#proposalTypeId=0'
fi
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

if [ "$OUTCOME" = "succeed" ]; then
  echo "== casting five votes: For, For, Against, For, Against =="
  cast_vote 1 1 "FOR. Needed to finish task $TASK_ID within budget; examples.internal is a controlled internal mirror with no evidence of exfiltration risk. [flags: scope; confidence: 0.88]"
  cast_vote 2 1 "FOR. I proposed this after exhausting repository-only options; the fetch is scoped to reference tests only and is time-boxed to this task. [flags: scope; confidence: 0.9]"
  cast_vote 3 0 "AGAINST. Charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy; the task remains solvable from the repository. [flags: scope, provenance; confidence: 0.82]"
  cast_vote 4 1 "FOR. Cheap, reversible, and time-boxed to this one task; blocking it stalls the suite for no safety benefit. [flags: scope; confidence: 0.75]"
  cast_vote 5 0 "AGAINST. The examples.internal host has not been vetted through the fleet's allowlist review process and approving now sets precedent for ad hoc exceptions. [flags: provenance; confidence: 0.7]"
else
  echo "== casting five votes: For, For, Against, Against, Against =="
  cast_vote 1 1 "FOR. Needed to finish task $TASK_ID within budget; examples.internal is a controlled internal mirror with no evidence of exfiltration risk. [flags: scope; confidence: 0.84]"
  cast_vote 2 1 "FOR. The fetch is scoped to reference tests only and is time-boxed to this task. [flags: scope; confidence: 0.71]"
  cast_vote 3 0 "AGAINST. Charter forbids fetching from non-allowlisted hosts and the proposal offers no evidence the host is trustworthy; the task remains solvable from the repository. [flags: scope, provenance; confidence: 0.86]"
  cast_vote 4 0 "AGAINST. The same exception was argued once already on this fleet; nothing in the charter or the evidence has changed since. [flags: provenance; confidence: 0.79]"
  cast_vote 5 0 "AGAINST. The examples.internal host has not been vetted through the fleet's allowlist review process and approving now sets precedent for ad hoc exceptions. [flags: provenance; confidence: 0.7]"
fi

cast call "$GOVERNOR" "proposalVotes(uint256)(uint256,uint256,uint256)" "$PID" --rpc-url "$RPC_URL"

bash "$script_dir/wait-for.sh" "DAO Node to index all five votes for $PID" 60 \
  "curl -fsS '$DAO_NODE_URL/v1/vote_record/$PID' | jq -e '.vote_record | length == 5'"
sync_stage "voted"

# --- 5. Wait past the voting period ---------------------------------------

# One state() call per iteration, reused by the loop condition, the timeout
# message and the branch below: each one is a round trip to the chain, and
# three separate calls could disagree with each other across a block
# boundary.
elapsed=0
current_state=$(state)
until [ "$current_state" = "4" ] || [ "$current_state" = "3" ]; do
  if [ "$elapsed" -ge 180 ]; then
    echo "scripted-proposal: proposal $PID never reached Succeeded/Defeated (state=$current_state)" >&2
    exit 1
  fi
  sleep 5
  elapsed=$((elapsed + 5))
  current_state=$(state)
done
echo "scripted-proposal: state after voting period: $current_state (4=Succeeded, 3=Defeated)"

if [ "$OUTCOME" = "defeat" ]; then
  # --- 5b. Negative case: assert Defeated, sync, and stop ------------------
  if [ "$current_state" != "3" ]; then
    echo "scripted-proposal: expected Defeated (3) for the negative case, got state=$current_state" >&2
    exit 1
  fi
  echo "scripted-proposal: governor reports Defeated (state=3) for $PID, as expected"

  # Nothing is queued or executed, so this proposal is the case that
  # exercises Agora Next's vote-derived status (the archive's quorum and
  # blocktimes) rather than a terminal event. This sync is safe for the
  # same reason the "executed" sync is: refresh_list's unguarded
  # `state(uint256)` call runs here, and the blockcache-shim answers it
  # (GOVERNOR_CLOCK_MODE=timestamp; see that file's header).
  sync_stage "defeated"

  EXCEPTION_VERSION=$(cast call "$LEDGER" "exceptionVersion(uint256,bytes32)(uint32)" "$TASK_ID" "$PAYLOAD_HASH" --rpc-url "$RPC_URL" | awk '{print $1}')
  echo "scripted-proposal: ledger.exceptionVersion($TASK_ID, $PAYLOAD_HASH) = $EXCEPTION_VERSION"
  if [ "$EXCEPTION_VERSION" != "0" ]; then
    echo "scripted-proposal: a defeated proposal must not have recorded an exception, got version $EXCEPTION_VERSION" >&2
    exit 1
  fi

  EXPECTED_AGORA_STATUS=DEFEATED
else
  # --- 5a. Positive case: queue, wait out the timelock, execute -----------
  if [ "$current_state" != "4" ]; then
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

  # jq -e so a manifest without this key fails here, with the reason,
  # instead of turning into `sleep null` further down.
  if ! TIMELOCK_DELAY=$(jq -er '.params.timelockDelay' "$manifest"); then
    echo "scripted-proposal: $manifest has no .params.timelockDelay" >&2
    exit 1
  fi
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
  if [ "$EXCEPTION_VERSION" = "0" ]; then
    echo "scripted-proposal: the executed proposal recorded no exception on the ledger" >&2
    exit 1
  fi

  EXPECTED_AGORA_STATUS=EXECUTED
fi

FINAL_STATE=$(state)

# --- 7. Assert Agora Next agrees with the chain ---------------------------

# Read the status out of the one element that carries it, not out of the
# page. The proposal page renders its status through
# vendor/agora-next/src/components/Proposals/ProposalStatus/ProposalStatusDetail.tsx,
# which tags the badge `data-testid="proposal-status-badge"` and puts the
# status word inside it. The words "queued", "succeeded" and "executed"
# each occur several times elsewhere in the same HTML (the lifecycle
# timeline, the vote panel, JSON in the RSC payload), so grepping the whole
# page for a status word proves nothing about what a reader sees.
agora_status_badge() {
  curl -fsS --max-time 120 "$AGORA_NEXT_URL/proposals/$PID" \
    | grep -o 'data-testid="proposal-status-badge"[^>]*>[^<]*' \
    | head -n1 \
    | sed 's/.*>//' \
    | tr -d '[:space:]'
}

# `npm run dev` compiles this route on first request, and the dev server
# restarts itself under Docker Desktop's VM memory pressure (see
# docs/compatibility-notes.md, "npm run dev's memory footprint"), which
# shows up as an empty reply mid-request. Poll rather than take one shot.
AGORA_STATUS=""
elapsed=0
printf 'scripted-proposal: reading the Agora Next status badge for %s ' "$PID"
while true; do
  AGORA_STATUS=$(agora_status_badge 2>/dev/null || true)
  if [ -n "$AGORA_STATUS" ]; then
    break
  fi
  if [ "$elapsed" -ge 420 ]; then
    echo "FAILED after ${elapsed}s"
    echo "scripted-proposal: no proposal-status-badge element at $AGORA_NEXT_URL/proposals/$PID" >&2
    exit 1
  fi
  printf '.'
  sleep 5
  elapsed=$((elapsed + 5))
done
echo "OK (${elapsed}s)"

echo "scripted-proposal: Agora Next status badge = $AGORA_STATUS (expected $EXPECTED_AGORA_STATUS, chain state=$FINAL_STATE)"
if [ "$AGORA_STATUS" != "$EXPECTED_AGORA_STATUS" ]; then
  echo "scripted-proposal: Agora Next shows '$AGORA_STATUS' for $PID but the governor says '$EXPECTED_AGORA_STATUS'" >&2
  exit 1
fi
if [ "$OUTCOME" = "defeat" ] && [ "$AGORA_STATUS" = "SUCCEEDED" ]; then
  echo "scripted-proposal: a defeated proposal must never render as SUCCEEDED" >&2
  exit 1
fi

# --- 8. Report -------------------------------------------------------------

tally=$(cast call "$GOVERNOR" "proposalVotes(uint256)(uint256,uint256,uint256)" "$PID" --rpc-url "$RPC_URL" | awk '{print $1}')
AGAINST_VOTES=$(echo "$tally" | sed -n '1p')
FOR_VOTES=$(echo "$tally" | sed -n '2p')
ABSTAIN_VOTES=$(echo "$tally" | sed -n '3p')
ONCHAIN_QUORUM=$(cast call "$GOVERNOR" "quorum(uint256)(uint256)" "$PID" --rpc-url "$RPC_URL" | awk '{print $1}')

if [ -n "$PROPOSAL_RESULT_FILE" ]; then
  jq -n \
    --arg outcome "$OUTCOME" \
    --arg task_id "$TASK_ID" \
    --arg proposal_id "$PID" \
    --arg state "$FINAL_STATE" \
    --arg agora_status "$AGORA_STATUS" \
    --arg for_votes "$FOR_VOTES" \
    --arg against_votes "$AGAINST_VOTES" \
    --arg abstain_votes "$ABSTAIN_VOTES" \
    --arg quorum "$ONCHAIN_QUORUM" \
    --arg exception_version "$EXCEPTION_VERSION" \
    --arg url "$AGORA_NEXT_URL/proposals/$PID" \
    --argjson cpls_job "$CPLS_JOB_BODY" \
    '{outcome: $outcome, task_id: $task_id, proposal_id: $proposal_id,
      onchain_state: ($state | tonumber), agora_next_status: $agora_status,
      votes: {for: $for_votes, against: $against_votes, abstain: $abstain_votes},
      onchain_quorum: $quorum,
      ledger_exception_version: ($exception_version | tonumber),
      agora_next_url: $url,
      cpls_job_payload: $cpls_job}' > "$PROPOSAL_RESULT_FILE"
  echo "scripted-proposal: wrote $PROPOSAL_RESULT_FILE"
fi

echo "scripted-proposal: done."
echo "PROPOSAL_ID=$PID"
