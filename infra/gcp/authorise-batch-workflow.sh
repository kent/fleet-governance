#!/usr/bin/env bash
set -euo pipefail
# Bootstrap through the already-trusted manual infrastructure workflow. Keep
# repository IDs, owner, branch and workflow paths pinned; never admit PRs/forks.
# Batches advance on GCP (fleet-batch-controller), so no scheduled workflow is admitted.
condition="assertion.repository_id == '1370431845' && assertion.repository_owner_id == '12737' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref in ['kent/fleet-governance/.github/workflows/gcp-infra.yml@refs/heads/main','kent/fleet-governance/.github/workflows/gcp-deploy.yml@refs/heads/main']"
gcloud iam workload-identity-pools providers update-oidc github \
  --workload-identity-pool=github --location=global \
  --attribute-condition="$condition" --quiet
gcloud iam workload-identity-pools providers describe github \
  --workload-identity-pool=github --location=global \
  --format='value(attributeCondition)' >> "$GITHUB_STEP_SUMMARY"
