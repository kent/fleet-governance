#!/usr/bin/env bash
set -euo pipefail
: "${IMAGE_RUNNER:?An immutable Runner image digest is required}"
[[ "$IMAGE_RUNNER" =~ ^us-central1-docker.pkg.dev/fleet-governance/fleet/runner@sha256:[a-f0-9]{64}$ ]]
# Public ingress is required for MCP clients. Every MCP request authenticates a
# revocable personal bearer credential before constructing a server or invoking tools.
gcloud run deploy fleet-governance-mcp --region=us-central1 --image="$IMAGE_RUNNER" \
  --command=node --args=apps/runner/dist/cloud/mcp-entrypoint.js --port=8080 \
  --service-account=fleet-mcp@fleet-governance.iam.gserviceaccount.com \
  --update-secrets=FLEET_OPERATOR_EMAILS_JSON=fleet-operator-emails:1 \
  --memory=512Mi --cpu=1 --min=0 --max=2 --concurrency=20 --timeout=60 \
  --no-allow-unauthenticated --no-invoker-iam-check --quiet
url=https://fleet-governance-mcp-449245570324.us-central1.run.app/mcp
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' "$url")
[[ "$status" == 401 ]]
printf 'MCP endpoint: %s. Unauthenticated requests rejected.\n' "$url" >> "$GITHUB_STEP_SUMMARY"
