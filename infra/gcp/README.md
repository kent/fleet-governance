# GCP research environment

GitHub Actions provisions the infrastructure and deploys the application. The browser starts experiments. Servers, agent sandboxes, signing keys and model calls stay on GCP.

## Current state

On September 15, 2026, the [foundation apply](https://github.com/kent/fleet-governance/actions/runs/34980731766) completed successfully. Compute Engine is enabled. The worker, private buckets, Artifact Registry, service accounts and experiment secrets are configured. The dedicated OpenRouter key retains the operator's **$50 non-resetting credit limit**. Each run defaults to a **$1 inference budget** from that pool.

The [wallet preparation run](https://github.com/kent/fleet-governance/actions/runs/34979195987) generated reusable testnet keys in Secret Manager and funded the deployer, operator, guardian, keeper and five agents with Base Sepolia ETH. The HTTP and WebSocket RPCs were verified against chain ID 84532. Five actual agents then cast ten votes across two proposals, with reasons visible in Agora. Artifact publication remained blocked. The run stopped on a provider output reservation overrun; its [report](../../docs/evidence/base-sepolia-20260915/report.md) preserves that failure alongside the confirmed votes.

Open the [launcher](https://fleet-governance-449245570324.us-central1.run.app/experiments) to run another experiment, or [Agora's info page](https://fleet-governance-449245570324.us-central1.run.app/info) to read how it works.

## Services and access

- Project: `fleet-governance`; region: `us-central1`.
- `fleet-governance` on Cloud Run is public. Its `fleet-public` identity can read experiment evidence and the fixed VM's state. It has no compute mutation, queue, secret or signing authority. The HTTP gateway accepts GET and HEAD only; supplied Google identity headers never grant permission.
- `fleet-governance-control` is the operator interface behind Google Identity-Aware Proxy. Its `fleet-control` identity can queue experiments and start the fixed worker. It has no wallet or model secrets.
- `fleet-research` in `us-central1-a` runs the trusted Runner, isolated test containers, Agora, DAO Node, CPLS and Postgres. It is an `e2-standard-8` with 8 vCPUs and 32 GiB RAM. The VM stops after four hours; its disks and records remain.
- The launcher reaches Agora over the private VPC. Application ports are closed to public ingress. IAP provides administrative SSH access. OS Login and Shielded VM protections are enabled.
- Viewing requires no login. Operator sign-in is restricted to `operator2@example.com`. The CI provisioner also has IAP access for verification.

Agents share the worker, with separate identities, workspaces and inference calls. The launcher supports 2 to 25 agents, with five selected by default. Agent count does not mean one VM per agent.

## Deploy or change infrastructure

1. Commit and push the change to `main`.
2. For infrastructure, open the [GCP infrastructure workflow](https://github.com/kent/fleet-governance/actions/workflows/gcp-infra.yml). Run `plan`, then `apply` after reviewing the plan. Use `start` or `stop` to control the existing worker without removing its data.
3. For application changes, run [GCP deploy Fleet demo](https://github.com/kent/fleet-governance/actions/workflows/gcp-deploy.yml). Leave `deploy` enabled. Disabling it builds and publishes images only.
4. For a website-only change, enable `site_only`. This builds only the Runner image and deploys the public reader and operator controls. It does not start or redeploy the VM, controller or preparation job.
5. Review the workflow summary and checks. The workflow builds four images, tests the Runner and contracts, checks Agora's vote archive reader, deploys immutable image digests, configures public viewing and separate IAP operator access, and releases the worker through IAP SSH.
6. The worker deployment checks the UI, Docker compatibility, sandbox isolation, timeout cleanup and the real tool-to-Docker path. It authenticates the inference key. The optional `verify_inference` input makes one live model request with a two-cent ceiling; it defaults to false.
7. If a fleet is already deployed, the workflow refreshes Agora and its indexers against that fleet. Deploying code does not create new contracts or start an experiment.

Deployment and experiments share a filesystem lock. A deployment stops if an experiment owns the worker. Finish that run before retrying deployment.

## Run, adjust and repeat

1. Open `/experiments` to browse without signing in. Use **Sign in to run** for the operator interface.
2. Choose the number of agents, enter a goal, and select the existing constitution or paste your own.
3. Press Run. The launcher saves an immutable request and starts the worker if it is stopped.
4. Follow funding, deployment, agent activity, proposals, ballots and execution evidence. Open a proposal in Agora to read the indexed vote reasons.
5. Use the completed run's copy-settings action, adjust the inputs and press Run again. That creates a new run ID and preserves the previous result.

One experiment runs at a time. Each run deploys a fleet for its submitted configuration, and Agora follows the active fleet. Previous run records remain available in the launcher. A stopped VM pauses availability of Agora; the launcher remains available. Use Wake Agora to view the current fleet, or Run to start a new experiment. Either can start the fixed worker.

The first task environment is a small coding repository with governed artifact publication. The goal field changes what agents attempt within that environment. Custom constitutions change instructions; they cannot bypass the gateway or contract executor.

A stale heartbeat is shown as stale. It is not treated as success. Review a failed run before starting another. A confirmed blockchain transaction cannot be undone by resetting the UI or stopping a VM.

## Identity and secrets

`fleet-provisioner` has project Owner access, as requested. GitHub uses Workload Identity Federation, with no service account JSON key. The provider accepts repository ID `1370431845`, owner ID `12737`, `refs/heads/main`, and manual executions of `gcp-infra.yml` or `gcp-deploy.yml`. Fork and pull-request jobs cannot obtain this identity.

`fleet-runtime` can read the experiment's secrets, pull images, write the two data buckets and emit logs and metrics. `fleet-control` can start only the fixed worker and access experiment queue records. Neither runtime identity can provision resources.

Secret Manager holds:

- `fleet-openrouter-experiment-api-key`: the dedicated $50 experiment key.
- `fleet-postgres-password` and `fleet-jwt-secret`: application credentials.
- `fleet-cdp-api-key-id` and `fleet-cdp-api-key-secret`: testnet faucet credentials.
- `fleet-base-sepolia-rpc-url` and `fleet-base-sepolia-ws-url`: Alchemy endpoints.
- `fleet-base-sepolia-wallets`: the reusable testnet signing keys.

The earlier `fleet-openrouter-api-key` secret is retained for the previous setup. New experiment deployments use the dedicated experiment key.

The worker loads numbered secret versions using its own identity. Application secrets live in a root-only file under `/run`. Wallet and RPC credentials are loaded into the trusted run process when needed. Agent test containers receive no credentials or Docker socket, have no network access and run as a non-root user. Runner has the host Docker socket because it manages those containers and is trusted control software.

Values never enter Terraform state or Git. The import actions accept temporary encrypted GitHub secrets, validate and read back the imported values, then report only names and version numbers. Remove the temporary repository secret after verification. Rotation is explicit; import actions refuse to overwrite a different existing credential silently.

The OpenRouter pool caps OpenRouter credits. Its current setting excludes external BYOK charges. The Runner separately reserves token and dollar budgets and enforces provider price and output limits. It does not change the provider's $50 setting.

## Records and recovery

Terraform state is private and versioned in `fleet-governance-tfstate-449245570324`. The private data buckets are `fleet-governance-artifacts-449245570324` and `fleet-governance-archive-449245570324`.

Requests, progress and completed evidence live under `demo/runs/<run-id>/` in the artifacts bucket. Reports and deployment records also live on the VM's separate data disk under `/srv/fleet/state`. The archive bucket contains Agora's indexed proposal and vote data. A loopback reader uses the VM identity to serve that private archive to Agora.

Stopping compute does not delete disks, secrets, objects or onchain permissions. Stored resources continue to incur charges. Replacing a VM and starting a new experiment are separate operations. Preserve the data disk when repairing the worker.

Public rollout first moves traffic to the read-only application and identity while IAP is still enabled. CI then disables IAP and the invoker IAM check for that service. The operator service keeps both checks. A cookie-free CI check verifies public pages and rejects mutation attempts with forged Google headers.

References: [Public Cloud Run access](https://docs.cloud.google.com/run/docs/authenticating/public), [Google's GitHub federation setup](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [Cloud Run with IAP](https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run), [Direct VPC](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc), [VM runtime limits](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime).
