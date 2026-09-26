#!/usr/bin/env bash
# Shared by the Guardian and the batch controller: a private Cloud Run service with one
# instance and one request at a time, invoked every minute by Cloud Scheduler under the
# scheduler's own identity. Sourced, not executed.
: "${IMAGE_RUNNER:?An immutable Runner image digest is required}"
[[ "$IMAGE_RUNNER" =~ ^us-central1-docker.pkg.dev/fleet-governance/fleet/runner@sha256:[a-f0-9]{64}$ ]]
scheduler=fleet-compute-scheduler@fleet-governance.iam.gserviceaccount.com

# deploy_scheduled_service <service> <entry script> <identity> <scheduler job> <timeout seconds> [extra gcloud run deploy flags...]
deploy_scheduled_service() {
  local service=$1 entry=$2 identity=$3 job=$4 timeout=$5
  shift 5
  gcloud run deploy "$service" --region=us-central1 --image="$IMAGE_RUNNER" \
    --command=node --args="apps/runner/dist/cloud/$entry" --port=8080 \
    --service-account="$identity@fleet-governance.iam.gserviceaccount.com" \
    --no-allow-unauthenticated --ingress=all --cpu=1 --memory=512Mi \
    --min=0 --max=1 --concurrency=1 --timeout="$timeout" "$@" --quiet
  local url
  url=$(gcloud run services describe "$service" --region=us-central1 --format='value(status.url)')
  [[ "$url" =~ ^https://$service-[a-z0-9-]+(\.a)?\.run\.app$ ]]
  gcloud run services add-iam-policy-binding "$service" --region=us-central1 \
    --member="serviceAccount:$scheduler" --role=roles/run.invoker --quiet >/dev/null

  local operation=create
  if gcloud scheduler jobs describe "$job" --location=us-central1 >/dev/null 2>&1; then operation=update; fi
  gcloud scheduler jobs "$operation" http "$job" --location=us-central1 \
    --schedule='* * * * *' --time-zone=UTC --uri="$url/reconcile" --http-method=POST \
    --oidc-service-account-email="$scheduler" --oidc-token-audience="$url" \
    --attempt-deadline="${timeout}s" --max-retry-attempts=3 --min-backoff=5s --max-backoff=30s --quiet
  if [[ "$(gcloud scheduler jobs describe "$job" --location=us-central1 --format='value(state)')" == PAUSED ]]; then
    gcloud scheduler jobs resume "$job" --location=us-central1 --quiet
  fi

  # Unauthenticated requests must not be able to drive the service.
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$url/reconcile")
  [[ "$status" == 403 || "$status" == 401 ]]
  gcloud scheduler jobs run "$job" --location=us-central1 --quiet
  printf '%s: %s. Only the Scheduler identity can invoke it.\n' "$service" "$url" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
}
