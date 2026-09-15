# Repeatable fleet experiments on GCP

Use GCP for the agents, sandboxes and services. Use a private Anvil chain on GCP for fast
experiments, then Base Sepolia for public demonstrations. A new Anvil instance can start with
an empty chain. Base Sepolia keeps its history: a fresh experiment opens a new task or deploys
a new fleet.

This is the experiment checklist, updated September 14, 2026. The current GCP setup and its
verification status live in the [infrastructure runbook](../infra/gcp/README.md). Infrastructure
and deployments run through GitHub Actions. Start with one research VM. Reset automation,
parameter generation and Base Sepolia are follow-on work. Agora Governor stays pinned and unchanged.

1. **Create the GCP project and choose its limits.**
   - [x] Use the billing-enabled `fleet-governance` project in `us-central1`, with a dedicated
     provisioner and GitHub Workload Identity Federation. No service account key is needed.
   - [ ] Complete the Terraform apply for Compute Engine, Artifact Registry, Secret Manager,
     Cloud Storage, Logging, Monitoring and IAP. Confirm regional CPU and disk quota for the pilot.
   - [ ] Set a project budget, alerts and a maximum experiment duration. An alerts-only budget
     does not stop a VM. Add an explicit automatic stop deadline and review which resources
     continue billing after compute stops. [Google Cloud budget documentation](https://docs.cloud.google.com/billing/docs/how-to/budgets)

2. **Provision the pilot machine and private access.**
   - [ ] Start with one Compute Engine VM: **8 vCPUs, 32 GiB RAM, Ubuntu 24.04 and a 100 GB
     balanced persistent disk**, with room to expand scratch storage. This is a proposed pilot
     size, not demonstrated capacity for 2,000 model agents. Hosted models need no GPU here.
   - [ ] Use the research VPC, an outbound IP on the VM, and IAP access for administration.
     One VM does not need a separate Cloud NAT gateway.
     Keep Runner, Postgres, DAO Node, CPLS and the Docker socket off the public internet.
     Runner can start work and use signing keys. Public access belongs on a separately
     configured read-only site. [IAP TCP forwarding](https://docs.cloud.google.com/iap/docs/using-tcp-forwarding)
   - [ ] Run the existing Docker sandbox on Compute Engine. Moving the runner to Cloud Run
     would require a different sandbox execution adapter; the current code expects control
     of a Docker daemon. Cloud Run restricts host operations and privileged containers.
     [Cloud Run runtime contract](https://docs.cloud.google.com/run/docs/container-contract)
   - [ ] Keep one active experiment per workspace initially. The current CLI shares deployment
     pointers, indexer settings and an inference coordinator. Adding VM replicas does not turn
     it into a distributed fleet runner.

3. **Store credentials outside the experiment files.**
   - [ ] Put the capped OpenRouter key, RPC credentials, testnet signing keys and application
     secrets in Secret Manager. Use a dedicated VM service account with access only to its
     required secrets, image repository and buckets. Pin secret versions in a private run
     manifest. [Secret Manager guidance](https://docs.cloud.google.com/secret-manager/docs/best-practices)
   - [ ] For the first model pilot, set the OpenRouter key to a **$1 credit limit, no reset,
     with BYOK usage included**. The current preflight also requires positive remaining credit
     no greater than the experiment's dollar budget. Increase the budget deliberately for
     later runs; resetting local files must never reset provider spending authority.
   - [ ] Verify the deployment's Secret Manager loader and systemd service on the VM. They
     inject pinned secret versions into the trusted Runner process. Never mount those
     credentials or the Docker socket into agent test containers.
   - [ ] Adapt CPLS to use the VM service account through Application Default Credentials.
     Its Python client supports ADC, but the current Compose file mounts a JSON credential
     file and preflight uses that file setting to distinguish real GCS from the emulator.
     Both need an explicit GCP configuration. Avoid downloading a service account key just
     to preserve that local convention.

4. **Prepare Base Sepolia access and funded identities.**
   - [ ] Get reliable HTTP and WebSocket RPC endpoints for **chain ID 84532**. Confirm request
     quotas, log range limits and receipt availability with the provider. Base publishes
     standard endpoints, but the fleet's measured workload should determine the RPC plan.
     [Base RPC reference](https://docs.base.org/base-chain/api-reference/rpc-overview)
   - [ ] Create separate deployer, operator, guardian and keeper identities, plus one funded
     identity per voting agent. A five-agent pilot needs **nine funded addresses**; 2,000
     agents currently need **2,004**. The code has no automatic gas sponsorship layer.
   - [ ] Fund them with **Base Sepolia test ETH**. Estimate deployment and transaction fees
     before choosing amounts; a nonzero balance passes the current preflight but does not
     prove it can finish a run. Do not use the published Anvil development keys on Sepolia.
   - [ ] Keep guardian authority under operator control. The current runner expects a guardian
     key too; moving it to a separate signer is implementation work, not a feature already
     provided by Secret Manager.
   - [ ] Deploy and verify the registry, token, timelock, ledger, hook, Governor, executor and
     artifact store. Record their addresses, code hashes and deployment block. Configure fee
     bounds for agents and the keeper, and separately review deployment gas.

5. **Keep results when compute is reset.**
   - [ ] Create a private GCS bucket for complete run bundles and a separate bucket for the
     public governance archive. Retain the private bucket across VM replacement and reset.
   - [ ] Publish only the intended proposals, ballots, manifests and reports. Remove private
     RPC credentials and other secrets from exported configurations and logs.
   - [ ] The current Agora archive reader uses unauthenticated URLs. A dedicated public archive
     is the existing path. If project policy prohibits public objects, implement authenticated
     archive reads or a read-only proxy before enabling the site.
   - [ ] Run Postgres privately on the VM for the pilot, with separate state for each experiment
     environment. Use consistent database backups and uploaded run bundles for recovery.
     Cloud SQL is a later option; it is not required to begin.
   - [ ] Upload the config, effective fixture and charter, source commit, image digests,
     deployment manifest, task ID, inference journal, tool events, receipts, artifact hashes,
     report and checksums under a unique run ID. Preserve failed and stopped runs too.
     Pinning these inputs makes a run inspectable; it does not make model output deterministic.

6. **Build the remote release and launcher.**
   - [x] Add Terraform for IAM, network, VM, buckets, secrets and image registry. Keep its state
     in a separate private bucket that experiment reset cannot delete. Apply through GitHub.
   - [ ] Build and tag images with the Git commit, and launch by image digest. Install the
     pinned dependencies and Foundry tools in the build. Build in GitHub Actions and deploy
     to GCP so nothing needs to remain running on a laptop.
   - [ ] Start services through systemd and Compose, persist the runner's state and inference
     journal, and take a single-experiment lock before dispatch. Retry startup without creating
     a second coordinator or granting a fresh inference budget to a resumed run.
   - [ ] Verify a production build of Agora Next before exposing it. Its current container runs
     `next dev`, and the local detail-page audit failed during compilation with the tested
     memory settings. More VM memory is a starting point, not proof that this is fixed.

7. **Make parameter changes produce a complete, versioned configuration.**
   - [ ] Add one configuration generator that writes the experiment, its matching
     `deployments/configs/<experiment.name>.deploy.json`, and any model fixture/charter copies.
     Validate all of them before starting a run.
   - [ ] Show the effective parameters and estimated maximum spend before dispatch. A model
     fixture currently supplies its own charter and repository, overriding a different
     `task.charter` in the experiment. Editing only that field can leave the actual task
     unchanged. The generator must resolve this explicitly.
   - [ ] Record every variant as a new run. Change one parameter at a time initially and repeat
     each variant to measure variation in model behaviour.

| Parameter to change | Existing source | Reset needed |
| --- | --- | --- |
| Agent count, roles and model | `fleet.members[]` and matching deployment config | Fresh fleet for membership changes; record any model change in the fleet manifest |
| Task, constitution, allowed tools, hosts and task tool budget | Effective model fixture and its charter file | New task with the resolved charter |
| Agent step limit | Model fixture `maxSteps` | New run/fixture version |
| Concurrent model calls and reserved vote capacity | `inference.concurrency`, `reservedVoteSlots`, `reservedVoteCalls` | New run |
| Call, token, dollar and output limits | `inference.maxCalls`, `inference.budget` | New run with matching provider credit authority |
| Concurrent tools and vote jobs | `runtime.toolConcurrency`, `runtime.voteConcurrency` | New run |
| Quorum, voting period, timelock and proposal threshold | `governance` plus matching deployment config | Fresh fleet for a clean comparison |
| Task duration and stop conditions | `task.lifetime` and effective charter | New task |

Temperature and seed are not exposed as experiment parameters today. Add provider support and
record the effective values before presenting either as a reproducibility control.

8. **Implement three explicit restart operations.**
   - [ ] **Resume:** use the same run ID, config, deployment, task and budget journal. Reconcile
     outstanding transactions and provider calls before retrying. Test a crash during a vote
     and during publication; the existing checkpoints are not proof of recovery at every point.
   - [ ] **Fresh task:** keep the deployed fleet, start a new task and run ID, and use clean
     workspaces and counters. This is useful for task or prompt comparisons.
   - [ ] **Fresh environment:** archive the current results, stop its work, and replace only
     that environment's state. On GCP Anvil, start a new chain and matching indexer/database
     state. On Base Sepolia, deploy fresh contracts and point a new archive/indexer environment
     at their deployment block. Existing public history remains.
   - [ ] Give each environment its own checkout or work directory, Compose project, database
     state and archive namespace. The current `latest.json` and `data/fleet/` archive paths
     make unrestricted parallel resets unsafe. Namespace them in the launcher.
   - [ ] Keep keys, archived results, Terraform state and unrelated environments outside reset
     targets. Never make a global Docker volume prune or bucket deletion part of reset.

9. **Make stop and denial observable.**
   - [ ] Keep the existing permission gates: no settled approval means no protected publication
     and no dispatch of the disputed tool request. Preserve the network-isolated test containers
     and package broker checks on GCP, including denial of cloud metadata access.
   - [ ] Add an operator stop command that prevents new dispatch, cancels queued work, terminates
     owned containers and reconciles pending jobs. Record whether cleanup succeeded.
   - [ ] Pause or close the affected task and revoke permissions or cancel queued timelock work
     where needed, then confirm the transactions. Stopping a VM does not revoke onchain authority.
   - [ ] Test an RPC outage, a rejected proposal, no ballots, a budget stop, a process crash and
     a manual stop. Prove that no new protected action is released. Already sent HTTP calls
     cannot be recalled; remote workloads need their own termination and credential controls.
   - [ ] Monitor actual model spend, queue depth, RPC errors, missing ballots, indexer lag,
     memory, disk use and containers left after a run. Keep these operational logs private.

10. **Increase scale after the reset loop works.**
    - [ ] Complete a five-agent run, save its evidence, reset it, change a parameter and run again.
    - [ ] Run the scripted approval/rejection checks on Base Sepolia, then the small model pilot
      without prescribing its votes.
    - [ ] Increase to 50, 200 and then 2,000 model agents. Measure before increasing concurrency.
      Two thousand agents do not need 2,000 simultaneous API calls or test containers.
    - [ ] Size the voting window from measured latency and throughput. A useful planning
      estimate is `ceil(voters / effective concurrent votes) × p95 vote-call time`, plus
      repair, queueing and transaction confirmation headroom. A short five-agent window should
      not be copied unchanged to a 2,000-agent run.
    - [ ] If multiple worker VMs become necessary, first implement remote sandbox dispatch,
      durable job ownership and a fleet-wide budget authority. The current coordinator owns
      these limits in one process. Kubernetes or autoscaling alone cannot supply that logic.

The GCP project, region and provisioning identity are configured. The model pilot still needs
a capped OpenRouter key. The next web3 stage needs Base Sepolia HTTP/WSS endpoints and funded
public wallet addresses. A domain is optional until the read-only site is ready. Keep credential
values in Secret Manager.

The current [Base Sepolia runbook](deployment-runbook.md) contains the CLI and environment names.
The [cost guide](scale-costs.md) explains the 2,000-agent model estimate. Infrastructure sizing,
RPC capacity and public-chain fees still need measurement on the proposed deployment.
