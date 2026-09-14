#!/bin/sh
# Creates the CPLS archive bucket in the offline fake-gcs-server container.
# Idempotent: a second run against an already-created bucket is treated as
# success, not an error. Task 6's bootstrap script is expected to call this
# after bringing up the "offline" compose profile.
set -eu

HOST="${FAKE_GCS_HOST:-http://localhost:4443}"
PROJECT="${FAKE_GCS_PROJECT:-fleet}"
BUCKET="${GCS_BUCKET_NAME:-fleet-archive-dev}"

response="$(curl -s -w '\n%{http_code}' -X POST \
  "${HOST}/storage/v1/b?project=${PROJECT}" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"${BUCKET}\"}")"

http_code="$(printf '%s' "$response" | tail -n1)"
body="$(printf '%s' "$response" | sed '$d')"

case "$http_code" in
  200|201)
    echo "create-fake-bucket: created bucket ${BUCKET}"
    ;;
  *)
    if printf '%s' "$body" | grep -qi 'exist'; then
      echo "create-fake-bucket: bucket ${BUCKET} already exists, continuing"
    else
      echo "create-fake-bucket: failed to create bucket ${BUCKET} (HTTP ${http_code}): ${body}" >&2
      exit 1
    fi
    ;;
esac
