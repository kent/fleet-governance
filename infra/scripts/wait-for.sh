#!/usr/bin/env bash
# wait-for.sh: poll a shell condition until it succeeds or a timeout elapses.
#
# Generic on purpose: bootstrap-local.sh and scripted-proposal.sh use it both
# for plain HTTP readiness ("curl -fsS <url>") and for application-level
# conditions docker's own healthchecks cannot see (a specific proposal count
# on DAO Node, a specific object name in the fake-gcs bucket listing, a CPLS
# job's terminal status).
#
# Usage: wait-for.sh "<description>" <timeout-seconds> <condition-command...>
#
# The condition is joined back into one string and run through `bash -c`, so
# it may use pipes, &&, curl | jq, etc. Polls every 2 seconds; on timeout,
# prints the condition's last output (stdout and stderr) to help diagnose
# and exits 1.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: wait-for.sh <description> <timeout-seconds> <condition-command...>" >&2
  exit 2
fi

description=$1
timeout=$2
shift 2
condition="$*"

interval=2
elapsed=0

printf 'wait-for: %s ' "$description"
until bash -c "$condition" >/dev/null 2>&1; do
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "FAILED after ${elapsed}s"
    echo "wait-for: last attempt's output for: $condition" >&2
    bash -c "$condition" >&2 || true
    exit 1
  fi
  printf '.'
  sleep "$interval"
  elapsed=$((elapsed + interval))
done
echo "OK (${elapsed}s)"
