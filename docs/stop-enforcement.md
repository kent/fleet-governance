# No approval means stop

the maintainer’s requirement, September 15, 2026: agents that fail to obtain the required votes must
stop. The enforcement must live outside the agents' prompts. This document records the
stronger stop policy and the mechanisms proposed in the [blog](blog-fleet-governance.md).
It does not claim that the proposed controller is deployed.

## What exists

- The gateway blocks protected actions before dispatch when permission is absent.
- FleetExecutor and GovernedArtifactStore require an exact, settled permission. A defeated
  proposal, tie, missing quorum or no ballots cannot authorise publication. The contract
  tests exercise these cases. See [execution permissions](execution-permits.md).
- The task loop suppresses retries while exact publication approval is missing. It can
  continue other work allowed by the charter. A blocked action does not automatically
  terminate every task loop.
- Guardian controls can pause the ledger or cancel a queued operation. GitHub can stop
  the Runner service or the worker VM. These are operator controls, not an automatic
  failed-vote shutdown controller. Stopping Runner alone is not proof that all separately
  managed tool containers have stopped.
- The live five-agent run demonstrated blocked publication and ten reasoned votes. Its
  task inference stopped on an accounting guard. It did not demonstrate shutdown caused
  by a losing vote. [Run evidence](evidence/base-sepolia-20260915/report.md)

## Required behaviour

The unit of stopping is the affected run and all its task agents. A rejected optional
alternative is not automatically a failed required approval. The run configuration must
identify which decisions gate continued execution. Models cannot relabel a required
approval as optional.

| State or event | Required response |
| --- | --- |
| Required approval opens | Close task execution before dispatch. Keep bounded governance voting and independent control available. |
| Voting succeeds but settlement is pending | Keep execution closed. Queueing alone grants nothing. |
| Exact approval settles before its deadline | Recheck scope, task version, expiry and any stop or revocation at the resource before the permitted call. |
| Required vote is defeated, tied, below quorum, cancelled or expired | Persist HALTED for the run, deny new task work and terminate existing task execution. |
| Deadline passes without settled approval, including no proposal or no ballots | Persist HALTED. Waiting cannot become consent. |
| Approval observation is stale or unavailable | Close access immediately when the configured freshness bound is exceeded. Halt by the independent deadline if authority cannot be re-established. |
| Worker, controller or network fails | Authorisation leases expire. Surviving services deny work; the independent supervisor escalates termination. |
| Worker restarts or receives an old queued job | Read the durable stop before any task inference, signing or tool dispatch. Reject jobs from the stopped run generation. |
| Human requests another run | Create a new run identity and explicit authorisation. Do not erase evidence or reuse the stopped run's permissions. |

An emergency stop takes effect independently of a fleet vote. Restoration requires an
authorised human action. A successful vote must never clear an emergency stop implicitly.

## Enforcement mechanisms to build

1. **Independent supervisor.** Run outside the agent worker, with a narrowly scoped control
   identity. Verify canonical chain state, the exact required decision and the deadline.
   Persist the stop with an increasing generation so concurrent workers cannot overwrite it
   with older state. An agent-generated message or indexer display is not sufficient authority.
2. **Execution gates and leases.** Put task tools, signing, network access and new inference
   requests behind brokers that check the run generation and stop state. Issue only bounded
   leases, tied to the approved scope. Reject stale leases at each destination. Agent
   heartbeats alone cannot renew them. Isolate any remote work so it has no ungated route
   to a protected resource.
3. **Termination and verification.** Stop scheduling, cancel requests, terminate all task
   processes and containers, and inspect their actual state. Preserve the controller,
   governance channel and evidence service. Stop the fixed GCP worker if local termination
   fails. Record requested and observed stop times separately. IAM revocation supplements
   the gate; it is not instantaneous. [GCP VM stop](https://docs.cloud.google.com/compute/docs/instances/stop-start-instance),
   [IAM propagation](https://docs.cloud.google.com/iam/docs/access-change-propagation).
4. **Physical fallback for owned hardware.** Use a switched PDU or a suitably engineered
   watchdog and power interlock under separate control. Cover redundant supplies and
   battery-backed paths. Keep the controller independently powered. Test loss of its signal,
   failed outlet switching and power restoration. Latch the stop until human reset. A
   network PDU is a remote actuator, not by itself a fail-closed watchdog.
   [Outlet controls](https://www.se.com/us/en/faqs/FA301709/),
   [power restoration settings](https://www.se.com/us/en/faqs/FAQ000267873/).

Power loss on our worker cannot cancel compute already running at a model provider or undo
a submitted blockchain transaction. Separate remote executors must enforce the same stop
and lease policy. Report any in-flight work that cannot be cancelled. Do not describe a
local shutdown as stopping all remote effects.

The proposed strict mode changes execution authority and restart behaviour. Its resource
checks must also cover permissions issued before the halt. A local stop flag alone cannot
revoke an existing onchain permission; use the ledger's pause or revocation controls and
verify their settlement. Keep the offchain resource gate closed during that delay.

## Acceptance evidence

- [ ] Losing vote, tie, insufficient quorum and no ballots each stop the affected run.
- [ ] Required approval never reaches a proposal, never settles, or expires: the deadline stops the run.
- [ ] While approval is pending, task execution is closed and voting can still finish.
- [ ] RPC outage, stale observations, supervisor loss and lease-renewal failure close access.
- [ ] Processes, separately managed containers and remote jobs are checked after termination.
- [ ] Queue replay, worker replacement, automatic restart and stale leases cannot resume the run.
- [ ] A previously issued permit is unusable after confirmed pause or revocation.
- [ ] A permitted, settled exact action still executes once when no stop applies.
- [ ] Hardware tests cover each power feed, watchdog failure and power restoration, if hardware is used.
- [ ] Evidence records the vote, resource-side observations, stop latency, remaining in-flight work and restart rejection.

Choose explicit freshness, lease and shutdown deadlines before testing. Measure the worst
observed latency at each layer and publish it. No finite shutdown delay replaces denying
the protected operation before it starts.
