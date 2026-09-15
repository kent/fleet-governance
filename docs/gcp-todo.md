# Run and repeat the fleet experiment on GCP

Use the browser to run experiments. Use GitHub to change infrastructure or deploy code. Nothing needs to stay running on your computer.

This checklist is updated September 15, 2026. The [GCP runbook](../infra/gcp/README.md) records the deployed resources, identities and secret names. The [demo checklist](turnkey-demo.md) tracks the live pilot's verification.

## One-time setup

- [x] Create the billing-enabled `fleet-governance` project in `us-central1`.
- [x] Configure GitHub Workload Identity Federation and a dedicated provisioner. No service account JSON key is needed.
- [x] Provision the worker, private network, disks, image registry, private buckets, logging and Secret Manager through Terraform in GitHub Actions.
- [x] Keep the worker runtime separate from the provisioner. Give the browser launcher access to the experiment queue and permission to start only the fixed worker.
- [x] Store the dedicated OpenRouter key with its existing **$50 non-resetting credit limit**. Keep the default run allowance at **$1**. Resetting an experiment does not reset the provider's credit pool.
- [x] Store and verify Alchemy HTTP and WebSocket endpoints for Base Sepolia, chain ID **84532**.
- [x] Store the CDP faucet credentials, generate reusable testnet signing keys in Secret Manager and fund the nine identities needed for five agents.
- [x] Set the worker to stop automatically after four hours. Disks and stored objects remain billable while it is stopped.
- [x] Deploy the application and verify Google sign-in, Agora `/info`, two actual proposals, ten indexed votes and public reasons. The [five-agent report](evidence/base-sepolia-20260915/report.md) records the results and the budget guard that stopped the run.
- [ ] Set a separate GCP billing budget and alerts if desired. The OpenRouter $50 limit applies to inference credits, not GCP charges. A [GCP budget alert](https://docs.cloud.google.com/billing/docs/how-to/budgets) does not stop compute.

## Start a run

1. Open the [experiment launcher](https://fleet-governance-449245570324.us-central1.run.app/experiments) and sign in as `operator2@example.com`.
2. Choose the agent count. The demo supports **2 to 25**, with **5** selected by default.
3. Enter the goal. The current task environment is a small coding repository with a governed artifact publication tool.
4. Use the existing constitution or paste a custom one. The chosen text and its hash are saved with the run and supplied to work and voting prompts.
5. Press Run. The launcher saves the request, starts the GCP worker if needed, and shows observed progress.
6. Follow the agents' activity and open the proposal in Agora. Read the decision, ballots and reasons, then check whether the exact protected action executed.

The agents use Muse Spark through OpenRouter. Each has a separate identity, workspace and model requests. They share one worker VM. Five agents do not mean five servers.

## Change parameters and run again

1. Open a completed run and copy its settings.
2. Change the agent count, goal or constitution.
3. Press Run to create a new experiment. Previous results remain available under their original run IDs.
4. Compare the proposal, ballots, missing votes, cost and protected-operation outcome. Change one parameter at a time initially.

One experiment runs at a time. Each run gets a configuration and deployment. Agora follows the current fleet; the launcher preserves earlier evidence. Base Sepolia transactions remain public after the run finishes.

Additional parameters belong in a reviewed code change and GitHub deployment:

| Parameter | Where to change it |
| --- | --- |
| Model and roles | `apps/runner/src/lib/demo-config.ts` |
| Inference call, token, dollar and output limits | The demo generator and its experiment template |
| Concurrent inference and reserved voting capacity | `inference` in the generated configuration |
| Concurrent tools and vote jobs | `runtime` in the generated configuration |
| Quorum, voting period, timelock and proposal threshold | `governance` in the generated configuration |
| Task duration and stop conditions | The generated task charter |
| Agent step limit and repository fixture | The selected model fixture |
| VM size and automatic stop time | Inputs to the GCP infrastructure workflow |

Do not expose RPC URLs, signing keys, filesystem paths or infrastructure permissions as browser parameters. A custom constitution changes instructions, not the executor's authority.

## Stop, recover and inspect

- Use the infrastructure workflow's `stop` action to stop the worker without deleting its data. The launcher remains available. Stopping a VM does not revoke an already settled onchain permission or undo a transaction.
- Use `inspect-demo` for read-only service checks, redacted logs and OpenRouter credit metadata. Diagnostics run in GitHub through IAP.
- Use Wake Agora in the launcher to start the fixed worker and view existing proposals without starting another experiment.
- A deployment refuses to replace the worker while an experiment holds its execution lock. Finish the run, then retry deployment.
- A failed or stale run is shown as failed or stale. Review its evidence before rerunning. A fresh run is a new experiment, not an assertion that the earlier one never happened.
- Preserve Secret Manager, Terraform state, `/srv/fleet/state` and the data buckets during repair. Do not make Docker volume pruning or bucket deletion part of reset.

The gateway holds disputed calls while permission is unresolved. The contract executor requires an exact, settled and unused approval. Rejection, missing ballots, timeout, expiry and changed arguments cannot become approval by default. The deployment also tests sandbox isolation and timeout cleanup.

## Before increasing scale

- [ ] Build and verify the [independent stop controller](stop-enforcement.md): failed required approval halts all task agents in the affected run, including queued work, and a restart cannot clear the stop.
- [x] Run five actual agents on Base Sepolia and save the proposals, indexed reasons and execution evidence. Ten votes settled; artifact publication remained blocked. The run stopped on a provider output reservation overrun and remains marked failed.
- [ ] Copy its settings, change a parameter and verify that another run preserves the first result.
- [ ] Exercise failure cases on the deployed stack: rejection, no ballots, RPC outage, budget exhaustion and interrupted work.
- [ ] Measure model spend, RPC load, voting latency, missing ballots, indexer lag, memory and disk use.
- [ ] Increase beyond 25 only after expanding wallet capacity, funding, voting windows and worker limits together.
- [ ] Implement durable job ownership, shared budget enforcement and remote sandbox dispatch before adding worker replicas. Autoscaling alone does not distribute the current runner.

The [cost guide](scale-costs.md) estimates a 2,000-agent model experiment. That scale has been exercised with scripted votes on a local chain. It has not yet been demonstrated with 2,000 independently deciding model agents.
