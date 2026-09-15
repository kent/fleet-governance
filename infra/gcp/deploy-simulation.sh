#!/usr/bin/env bash
set -euo pipefail
# Trusted preparation only. Inference and vote submission execute on the governed VM.
gcloud run jobs deploy fleet-simulation --region=us-central1 --image="$IMAGE_RUNNER" \
  --command=node --args=apps/runner/dist/cloud/simulation-prepare.js \
  --service-account=fleet-simulation@fleet-governance.iam.gserviceaccount.com \
  --memory=512Mi --cpu=1 --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=600s --quiet
# Invoker has no run.jobs.runWithOverrides permission. The launcher cannot alter
# the image, identity, arguments, environment, task count or timeout.
gcloud run jobs add-iam-policy-binding fleet-simulation --region=us-central1 \
  --member=serviceAccount:fleet-control@fleet-governance.iam.gserviceaccount.com --role=roles/run.invoker --quiet
