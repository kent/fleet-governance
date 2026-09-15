#!/usr/bin/env bash
set -euo pipefail
# First deploy the isolated operator surface. Only IAP can invoke it.
gcloud beta services identity create --service=iap.googleapis.com --quiet
operator=https://fleet-governance-control-449245570324.us-central1.run.app
gcloud run deploy fleet-governance-control --region=us-central1 --image="$IMAGE_RUNNER" \
  --command=node --args=apps/runner/dist/cloud/server.js --port=8080 \
  --service-account=fleet-control@fleet-governance.iam.gserviceaccount.com \
  --memory=1Gi --cpu=1 --min=0 --max=2 --concurrency=40 --timeout=60 \
  --network=fleet-research --subnet=fleet-research --network-tags=fleet-control --vpc-egress=private-ranges-only \
  --set-env-vars="FLEET_AGORA_HOST=$FLEET_AGORA_HOST,FLEET_REVISION=$IMAGE_REVISION,FLEET_SITE_ACCESS=operator,FLEET_OPERATOR_URL=$operator" \
  --no-allow-unauthenticated --invoker-iam-check --iap --quiet
gcloud run services add-iam-policy-binding fleet-governance-control --region=us-central1 \
  --member=serviceAccount:service-449245570324@gcp-sa-iap.iam.gserviceaccount.com --role=roles/run.invoker --quiet
for member in user:operator2@example.com serviceAccount:fleet-provisioner@fleet-governance.iam.gserviceaccount.com; do
  gcloud iap web add-iam-policy-binding --member="$member" --role=roles/iap.httpsResourceAccessor \
    --region=us-central1 --resource-type=cloud-run --service=fleet-governance-control --quiet
done
# The original shared URL becomes public. Its different service identity cannot
# mutate resources even if a request manages to evade the read-only HTTP gate.
gcloud run deploy fleet-governance --region=us-central1 --image="$IMAGE_RUNNER" \
  --command=node --args=apps/runner/dist/cloud/server.js --port=8080 \
  --service-account=fleet-public@fleet-governance.iam.gserviceaccount.com \
  --memory=1Gi --cpu=1 --min=0 --max=2 --concurrency=40 --timeout=60 \
  --network=fleet-research --subnet=fleet-research --network-tags=fleet-control --vpc-egress=private-ranges-only \
  --set-env-vars="FLEET_AGORA_HOST=$FLEET_AGORA_HOST,FLEET_REVISION=$IMAGE_REVISION,FLEET_SITE_ACCESS=public,FLEET_OPERATOR_URL=$operator" \
  --iap --invoker-iam-check --quiet
# Switch to the verified read-only revision before opening ingress. This prevents
# the previous privileged revision becoming public during a rolling deployment.
gcloud run services update-traffic fleet-governance --region=us-central1 --to-latest --quiet
gcloud run services update fleet-governance --region=us-central1 --no-iap --no-invoker-iam-check --quiet
printf 'FLEET_CONTROL_URL=https://fleet-governance-449245570324.us-central1.run.app\n' >> "$GITHUB_ENV"
