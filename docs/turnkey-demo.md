# Turnkey experiment demo

Choose the number of agents, give them a goal, choose a constitution and press Run. Watch them work, challenge a proposed action and vote with reasons. A protected action waits for settled approval before it can execute.

## Implementation checklist

- [x] GCP foundation and GitHub Actions deployment with workload identity.
- [x] Verify CDP credentials and Base Sepolia HTTP and WebSocket RPC. Store credentials in Secret Manager.
- [ ] Store a separate, capped OpenRouter experiment key.
- [ ] Carry the submitted goal and constitution into work and voting prompts. Capture the exact text with each run.
- [ ] Add an authenticated experiment launcher that remains available while the worker VM is stopped.
- [ ] Queue immutable run requests in private Cloud Storage. Start the existing GCP worker and report observed provisioning states.
- [ ] Generate reusable test wallets on GCP, fund them through the CDP faucet and check gas requirements.
- [ ] Deploy FleetGov ERC20Votes and the existing governor contracts on Base Sepolia.
- [ ] Show agent steps, objections, proposals, votes, reasons and execution evidence as they arrive.
- [ ] Deploy Agora's production read side. Index actual votes and link the experiment and constitution from `/info`.
- [ ] Complete a five-agent model run and verify receipts, indexed reasons and execution enforcement.
- [ ] Verify reruns preserve previous results and a denied or unresolved action cannot dispatch.

## Small research deployment

GitHub Actions provisions infrastructure and deploys pinned images. A small Cloud Run service, protected by Google Identity-Aware Proxy, serves the launcher. Its Run action writes a request and starts the existing research VM. Starting a worker is an experiment operation; infrastructure and application changes still go through CI.

The VM runs the existing Runner pipeline and Agora read side. Agents share this server, with separate identities, workspaces and inference calls. Agent count does not mean one VM per agent. One experiment runs at a time in this POC so two runs cannot overwrite the active indexer configuration.

Each request has a new run ID. Configuration, selected constitution, progress and evidence stay under that ID. A rerun creates another request. Restarting a failed worker resumes the same request only where its transaction checkpoints make that safe.

## What the demo proves

The timeline distinguishes a requested action, a gateway decision, an onchain vote and a completed resource write. Model rationales are public explanations, not proof that a model reasoned correctly. Shared models may share blind spots. Votes can disagree, abstain or fail to arrive.

Custom constitutions change the agents' instructions. They cannot change the gateway's permissions, give the sandbox credentials, or bypass the executor. Without the required settled yes vote, the protected operation stays blocked. A rejected, expired or unresolved proposal never becomes permission by default.

The initial task environment is a small coding workspace with governed artifact publication. Free text sets the goal within that environment. It does not give agents arbitrary GCP access.

## Completion evidence

Record the deployed Git revision, service URL, FleetGov and governor addresses, run ID, five model-backed identities, proposal and vote transaction hashes, indexed reasons, and protected-operation outcome. Report measured cost and missing evidence without filling gaps with simulated events.
