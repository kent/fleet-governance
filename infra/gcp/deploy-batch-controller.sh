#!/usr/bin/env bash
set -euo pipefail
# Called only by the GitHub deployment job, after the Guardian, so a new run never
# starts without its shutdown controller.
source "$(dirname "$0")/scheduled-service.sh"
deploy_scheduled_service fleet-batch-controller batch-server.js fleet-batch-controller fleet-batch-reconcile 300 \
  --update-secrets=FLEET_OPERATOR_EMAILS_JSON=fleet-operator-emails:1
# Narrow, resource-level grants: run the preparation job without overrides, and read the
# Guardian service's readiness. It cannot deploy, change or delete the Guardian.
gcloud run jobs add-iam-policy-binding fleet-simulation --region=us-central1 \
  --member=serviceAccount:fleet-batch-controller@fleet-governance.iam.gserviceaccount.com --role=roles/run.invoker --quiet >/dev/null
gcloud run services add-iam-policy-binding fleet-compute-controller --region=us-central1 \
  --member=serviceAccount:fleet-batch-controller@fleet-governance.iam.gserviceaccount.com --role=roles/run.viewer --quiet >/dev/null
