# Turnkey experiment demo

Choose the number of agents, give them a goal, choose a constitution and press Run. Watch them work, challenge a proposed action and vote with reasons. A protected action waits for settled approval before it can execute.

## Implementation checklist

- [x] GCP foundation and GitHub Actions deployment with workload identity.
- [x] Verify CDP credentials and Base Sepolia HTTP and WebSocket RPC. Store credentials in Secret Manager.
- [x] Store a separate, capped OpenRouter experiment key.
- [x] Carry the submitted goal and constitution into work and voting prompts. Capture the exact text with each run.
- [x] Add an authenticated experiment launcher that remains available while the worker VM is stopped.
- [x] Queue immutable run requests in private Cloud Storage. Start the existing GCP worker and report observed provisioning states.
- [x] Generate reusable test wallets on GCP and fund the pilot through the CDP faucet.
- [x] Verify those balances cover the full public-testnet deployment and voting run.
- [x] Deploy FleetGov ERC20Votes and the existing governor contracts on Base Sepolia.
- [x] Show agent steps, objections, proposals, votes, reasons and execution evidence as they arrive.
- [x] Deploy Agora's production read side. Index actual votes and link the experiment and constitution from `/info`.
- [x] Complete a five-agent model run and verify receipts, indexed reasons and execution enforcement. The run's accounting check remains failed, as described below.
- [x] Verify reruns preserve previous results and a denied or unresolved action cannot dispatch.

## Small research deployment

GitHub Actions provisions infrastructure and deploys pinned images. A small Cloud Run service, protected by Google Identity-Aware Proxy, serves the launcher. Its Run action writes a request and starts the existing research VM. Starting a worker is an experiment operation; infrastructure and application changes still go through CI.

The VM runs the existing Runner pipeline and Agora read side. Agents share this server, with separate identities, workspaces and inference calls. Agent count does not mean one VM per agent. One experiment runs at a time in this POC so two runs cannot overwrite the active indexer configuration.

Each request has a new run ID. Configuration, selected constitution, progress and evidence stay under that ID. A rerun creates another request. Restarting a failed worker resumes the same request only where its transaction checkpoints make that safe.

## What the demo proves

The timeline distinguishes a requested action, a gateway decision, an onchain vote and a completed resource write. Model rationales are public explanations, not proof that a model reasoned correctly. Shared models may share blind spots. Votes can disagree, abstain or fail to arrive.

Custom constitutions change the agents' instructions. They cannot change the gateway's permissions, give the sandbox credentials, or bypass the executor. Without the required settled yes vote, the protected operation stays blocked. A rejected, expired or unresolved proposal never becomes permission by default.

The dedicated OpenRouter key keeps the operator's $50 total credit limit. A run defaults to a $1 inference budget, enforced by the Runner's token and dollar reservations, maximum provider prices and output limits. The $50 provider pool is separate from each run's allowance. Its current setting excludes bring-your-own-key charges, so it is a cap on OpenRouter credits rather than a universal cap on external provider accounts. The demo uses the configured Muse Spark model through OpenRouter.

The initial task environment is a small coding workspace with governed artifact publication. Free text sets the goal within that environment. It does not give agents arbitrary GCP access.

## Deployed launcher

The [experiment launcher](https://fleet-governance-449245570324.us-central1.run.app/experiments)
is public. Starting a run opens the separate operator interface, where sign-in is restricted to
`operator2@example.com`. Its default settings, run history endpoint,
layout and custom constitution control were checked in the browser on September 15, 2026.
The [first pilot](evidence/base-sepolia-pilot-20260915.md) failed before a proposal and cost
$0.0410297. The [next run](evidence/base-sepolia-20260915/report.md) produced two proposals,
ten confirmed votes and ten indexed reasons. Both decisions executed. The artifact stayed
unpublished because neither decision granted publication permission. That run cost $0.031897718.
Its overall checks remain failed because a provider response exceeded its output reservation;
the guard stopped further task inference. The subsequent request-limit fix preserves both
the $1 run allowance and the $50 provider limit.

Use **Wake Agora** to start a stopped worker and inspect its latest governance state without
launching another model experiment. The worker stops after four hours; the launcher and saved
run evidence remain available. Use **Run** to create a fresh experiment. The GCP infrastructure
workflow also has a `stop-experiment` action that stops the worker service while preserving
the disk and onchain history. Deploying through CI starts that service again.

## Completion evidence

Record the deployed Git revision, service URL, FleetGov and governor addresses, run ID, five model-backed identities, proposal and vote transaction hashes, indexed reasons, and protected-operation outcome. Report measured cost and missing evidence without filling gaps with simulated events.
