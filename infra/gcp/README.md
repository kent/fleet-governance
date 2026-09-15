# GCP research environment

Infrastructure and deployment run in GitHub Actions. This directory keeps the configuration
in the repository so a new machine can reproduce it. Local access is only needed for the
initial identity bootstrap and entering secret values.

Project: `fleet-governance`. Region: `us-central1`. VM: `fleet-research` in `us-central1-a`.
The initial VM is an `e2-standard-8` with 8 vCPUs and 32 GiB RAM. It stops automatically after
four hours. The workflow accepts a smaller machine and a runtime limit of 1 to 24 hours.
Persistent disks and stored objects remain after compute stops and continue to incur charges.

The dedicated provisioner is `fleet-provisioner@fleet-governance.iam.gserviceaccount.com`.
It has project-level Owner access, as requested. GitHub uses Workload Identity Federation;
there is no service account JSON key. The identity provider accepts only repository ID
`1370431845`, owner ID `12737`, `refs/heads/main`, and manual executions of `gcp-infra.yml`
or `gcp-deploy.yml`. Forks and pull-request jobs cannot use this provider.

The VM uses `fleet-runtime`, a separate account with access to the experiment's secrets,
image repository, data buckets, logging and metrics. It cannot provision resources. The VM
has an outbound IP to avoid running a separate NAT gateway for one research machine. The
only ingress rule is SSH through IAP; application ports are not public. OS Login and Shielded
VM protections are enabled.

Use the [GCP infrastructure workflow](https://github.com/kent/fleet-governance/actions/workflows/gcp-infra.yml)
on `main`:

1. Choose `plan` to inspect changes. The first run also creates the private Terraform state bucket.
2. Choose `apply` to create or update the environment from a saved Terraform plan.
3. Choose `start` or `stop` to control the VM without removing its data.

The state bucket is `fleet-governance-tfstate-449245570324`. Terraform creates private buckets
for artifacts and the governance archive. Public archive access is deferred until the web3
deployment is configured. State, data buckets, secrets and the data disk are preserved by
default. Replacing a VM is different from resetting a research run.

Secret Manager contains three secret containers:

- `fleet-openrouter-api-key`
- `fleet-postgres-password`
- `fleet-jwt-secret`

Secret values are entered separately and never appear in Terraform configuration or state.
The OpenRouter credit cap remains a provider-side setting. The model preflight requires a
non-resetting cap, positive remaining credit no greater than the run budget, and BYOK usage
included. Storing a key does not approve an unlimited model run.

Wallet keys, Base Sepolia RPC credentials and public chain deployment are the next stage.
The broader [experiment checklist](../../docs/gcp-todo.md) describes the remaining reset,
parameter and scaling work. A stopped VM does not revoke onchain permissions or recall a
request that was already sent.

The initial bootstrap enabled IAM, IAM Credentials and STS, created the provisioner and
GitHub identity pool/provider, and granted the repository `roles/iam.workloadIdentityUser`
on that service account. Subsequent resource changes belong in the workflows. The provider
condition and role grants can be inspected through GCP IAM.

References: [Google's GitHub federation setup](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
[service account access scopes](https://docs.cloud.google.com/compute/docs/access/service-accounts),
[VM runtime limits](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime).
