#!/usr/bin/env bash
set -euo pipefail

# Called only by the GitHub deployment job after Terraform provisions the identities.
: "${IMAGE_RUNNER:?An immutable Runner image digest is required}"
[[ "$IMAGE_RUNNER" =~ ^us-central1-docker.pkg.dev/fleet-governance/fleet/runner@sha256:[a-f0-9]{64}$ ]]
controller=fleet-compute-controller
scheduler=fleet-compute-scheduler@fleet-governance.iam.gserviceaccount.com

gcloud run deploy "$controller" --region=us-central1 --image="$IMAGE_RUNNER" \
  --command=node --args=apps/runner/dist/cloud/compute-server.js --port=8080 \
  --service-account=fleet-compute-controller@fleet-governance.iam.gserviceaccount.com \
  --no-allow-unauthenticated --ingress=all --cpu=1 --memory=512Mi \
  --min=0 --max=1 --concurrency=1 --timeout=120 --quiet
url=$(gcloud run services describe "$controller" --region=us-central1 --format='value(status.url)')
[[ "$url" =~ ^https://fleet-compute-controller-[a-z0-9-]+\.a\.run\.app$ || "$url" =~ ^https://fleet-compute-controller-[a-z0-9-]+\.run\.app$ ]]
gcloud run services add-iam-policy-binding "$controller" --region=us-central1 \
  --member="serviceAccount:$scheduler" --role=roles/run.invoker --quiet >/dev/null

operation=create
if gcloud scheduler jobs describe fleet-compute-policy --location=us-central1 >/dev/null 2>&1; then operation=update; fi
gcloud scheduler jobs "$operation" http fleet-compute-policy --location=us-central1 \
  --schedule='* * * * *' --time-zone=UTC --uri="$url/reconcile" --http-method=POST \
  --oidc-service-account-email="$scheduler" --oidc-token-audience="$url" \
  --attempt-deadline=120s --max-retry-attempts=3 --min-backoff=5s --max-backoff=30s --quiet

# Unauthenticated requests must not be able to drive the controller.
status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/reconcile")
[[ "$status" == 403 || "$status" == 401 ]]
gcloud scheduler jobs run fleet-compute-policy --location=us-central1 --quiet
printf 'Independent compute controller: %s. Only the Scheduler identity can invoke it.\n' "$url" >> "$GITHUB_STEP_SUMMARY"
