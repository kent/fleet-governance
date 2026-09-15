# GCP research environment

Infrastructure and deployment run in GitHub Actions. This directory keeps the configuration
in the repository so a new machine can reproduce it. Local access is only needed for the
initial identity bootstrap and entering secret values.

Status on September 14, 2026: GitHub federation, both service accounts, the private state and
data buckets, Artifact Registry and all three secret versions are configured. The stored
OpenRouter credential authenticates without an inference request. Its provider credit limit
is still unset, so the model pilot's budget preflight remains blocked.

The [verified image build](https://github.com/kent/fleet-governance/actions/runs/34921052560) passed
TypeScript checks, the production build and a UI startup check without credentials or external
network access. It published an immutable image to Artifact Registry. The
[latest infrastructure apply](https://github.com/kent/fleet-governance/actions/runs/34920988985)
removed the unused default service account's automatic Editor grant. VM creation is
currently blocked by Google's Compute Engine activation error: the service is being
deactivated and cannot be activated until that finishes. The workflow preserves completed
resources in Terraform state. There is no running GCP Runner yet.

To continue after Google clears the service state, run infrastructure `apply`, then run
the deployment workflow with `deploy` enabled. If the error persists, Google Cloud support
needs to inspect Compute Engine activation for project number `449245570324`. No API disable,
project replacement or state deletion is needed to retry.

Project: `fleet-governance`. Region: `us-central1`. VM: `fleet-research` in `us-central1-a`.
The configured VM is an `e2-standard-8` with 8 vCPUs and 32 GiB RAM. It stops automatically after
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
After Terraform creates the containers, an authenticated operator can run
`python3 infra/gcp/seed-secrets.py` once. It hides OpenRouter input, generates the two application
secrets, uploads values through standard input, and preserves any existing versions. This is
the one-time secret input step; routine builds and deployments use GitHub.

The OpenRouter credit cap remains a provider-side setting. The model preflight requires a
non-resetting cap, positive remaining credit no greater than the run budget, and BYOK usage
included. Storing a key does not approve an unlimited model run.

Once those secret versions exist, use the
[GCP deploy Runner workflow](https://github.com/kent/fleet-governance/actions/workflows/gcp-deploy.yml).
Leave `deploy` enabled to release the application. Disable it to build and publish an image
without starting or connecting to the VM.
It checks the secret versions, builds the current `main` revision, runs TypeScript checks and
the production Next build, verifies that the image serves the UI without credentials or
external network access, pushes it to Artifact Registry, and deploys its immutable
digest through IAP. Node, Foundry and workflow actions are pinned. Credentials generated by
GitHub authentication are excluded from the image context.

The VM fetches numbered secret versions using its own identity. Values live in a root-only
file under `/run`, and are injected only into the trusted Runner container. The agent test
containers receive neither these credentials nor the Docker socket. Runner itself needs the
host Docker socket to manage those sandboxes; it is trusted control software, not an agent
workspace. Completed reports and deployment records live on the separate persistent data disk.

Deployment checks the private UI and authenticates the OpenRouter key without requesting
inference. It refuses to replace a Runner with an active headless experiment process. This is
a research deployment, not a claim of recovery for every crash or external workload.

For private browser access after deployment, tunnel from an account with IAP and OS Login
access and the right to use the VM's service account:

```sh
gcloud compute ssh fleet-research --project=fleet-governance --zone=us-central1-a \
  --tunnel-through-iap -- -N -L 13100:127.0.0.1:3100
```

Then open `http://localhost:13100`. The browser is local; the server, agents and tools run on GCP.
No public application port is opened by these workflows.

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
