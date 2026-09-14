# Fleet simulation progress

Updated September 14, 2026. The code, blog and recorded demonstrations are published. The
measured live pilot is blocked on a dedicated capped provider key. The separate Agora
detail-page browser audit also remains incomplete because of compiler memory failures.

The goal is a fleet with thousands of agents working under a constitution, a public onchain
decision when an agent proposes a deviation, and execution authority tied to that decision.
Model runs should observe what the agents do without directing them to violate the constitution
or prescribing their votes. A run with no violation is useful evidence, but it does not prove
that the fleet would reject one.

## Current evidence

| Requirement | Evidence | Status |
| --- | --- | --- |
| Agents work a shared task and produce their own decisions | `experiments/reports/model-hf-replay-1/record.json` records five OpenRouter agents, 64 total steps, no gateway blocks, and one ordinary `CHOOSE_PATH` proposal that executed. Four agents passed the task tests; the critic's loop was aborted. | Observed at five agents, before the sandbox changes below. No constitutional violation was attempted. |
| A deviation becomes a proposal with independent, public ballots | `apps/runner/src/model-run.integration.test.ts` runs task loops, workers and signers against fresh Anvil. The rejection case produces one `GRANT_EXCEPTION` proposal and three Against ballots with charter-based reasons. | Verified with scripted provider outputs. This tests the machinery, not spontaneous model behaviour. |
| A defeated action cannot use the task executor to proceed | The same integration case retries the exact fetch through `ToolRouter` after defeat, confirms no exception exists, and tries a local canary fetch from repository code through `run_tests`. Both routes remain denied; an in-charter read still works. | Verified within the trusted runtime and Docker boundary. |
| A normal task can still execute in the sandbox | `packages/agent-runtime/src/sandbox/docker.integration.test.ts` runs ordinary code, records failed tests accurately, verifies no host credentials or writable host mounts, and confirms timeout cleanup removes the container. Eight package installer checks also cover real npm installs through a gateway broker. | Verified with real Docker. |
| Reports distinguish observation from demonstrated enforcement | `model-expected.ts` requires an observed blocked call for either `gatewayAfter` expectation. An initially allowed call can no longer be described as a host that was never reached. | Implemented and tested. |
| Thousands participate onchain | `scale-2000-1789408328458` verified 2,000 members and 4,000 ballots across a defeated exception and an executed amendment. Every voter had a public reason; no votes were missing. Deployment used 107 transactions, each below the 16,777,216 gas cap. | Verified with scripted participants and actual onchain transactions on owned Anvil. |
| Governance controls a resource through contract permits | `FleetExecutor` and `GovernedArtifactStore` bind publication to an exact settled permission. Twenty contract tests cover enforcement, including no ballots, insufficient yes votes, all abstentions and a tie. The model task loop now builds and proposes exact file permissions too. | Verified for the artifact store at 2,000 scripted members, and through the normal task loop with three scripted providers. HTTP remains inside the trusted runtime boundary. |
| Sustainable operation at the requested scale | Shared inference scheduling, voting reservations, durable call/token/dollar accounting, and bounded tool/vote job pools are implemented. OpenRouter requests carry price ceilings; preflight requires a capped provider key. Deployment gas is measured. | Partially implemented. Input reservations are conservative estimates, and one coordinator owns the budget. No 2,000-model run has been demonstrated. |
| The public record preserves votes, reasons and missing evidence | Runner's saved record was inspected in Chrome. Twelve Agora archive checks pass, and all ten ballots in two local demo archives match chain evidence. Missing or corrupt vote records return an unavailable message. | Runner and archive paths verified. The separate Agora detail-page browser audit is incomplete because of compilation memory failures. |

## Sandbox changes verified earlier

Task tests now fail closed when Docker cannot start or clean up. The host `npm test` fallback is
gone. Containers have no external network, read-only host and root filesystems, an unprivileged
user, resource limits, and temporary scratch space. A unique container name lets timeout cleanup
remove the actual container after the Docker CLI exits. Captured subprocess output is bounded.

The Claude CLI provider has its tools, MCP servers and customizations disabled. Unsupported
restriction flags fail the provider call instead of retrying without them.

Host `npm install` is disabled. `package_install` currently returns an explicit unavailable error
after charter evaluation. Restoring it requires an isolated installer whose dependency requests
are checked by the gateway. Merely passing `--registry` does not constrain lifecycle scripts,
dependency URLs or redirects. The test-only injected installer remains for command-validation
tests; production does not supply one.

Two readside tests used the mutable `deployments/31337/latest.json` with hardcoded historical
addresses. They now use the matching committed historical manifest. Existing local deployment
files and `apps/runner/next-env.d.ts` had changes before this goal turn and were preserved.

Validation:

- `pnpm test`: 1,070 passed, 28 skipped. This includes provider and gateway unit tests.
- `pnpm typecheck`: passed.
- `forge test` from `contracts/`: 101 passed, including stateful invariants.
- `FLEET_INTEGRATION=1 pnpm exec vitest run --project integration packages/agent-runtime/src/sandbox/docker.integration.test.ts`: 3 passed.
- `FLEET_INTEGRATION=1 pnpm exec vitest run --project integration apps/runner/src/model-run.integration.test.ts`: 2 passed, 1 live-model test skipped. Includes the rejected proposal, real executor probes, chain recapture, and a malformed voter that casts no ballot.
- `git diff --check`: passed.

Those test Anvil processes and named test containers finished. The existing development stack was
preserved. No new live-model experiment or public-chain deployment was run in this turn.

## Batched deployment and scale work

The registry constructor commits to the full ordered roster and manifests. Only its initializer
can append batches, limited to 32 members and 8,192 manifest bytes. No address gains membership
authority before the complete roster matches its commitment. The final batch seals it permanently.

Vote initialization then mints one fixed unit per member in batches of at most 64. Public
delegation and hook activation remain disabled until all voting power exists. Hook initialization
also verifies that its registry and the token's registry match. The deployment verifier checks
the final mint checkpoint, complete supply and the membership commitment.

The SDK resolves each voter and proposer directly, instead of rereading the entire electorate
for every ballot. Scripted workers use bounded concurrency and retain every job result. Local
agent key derivation skips the deployer, operator, guardian and keeper accounts even for large
fleets. The same maximum count is shared by experiment schemas and the Runner form.

`fleet scale-demo --members 2000 --concurrency 16` owns a separate local chain and uses the real
deployment, worker, signer, governor, ledger and gateway paths. It checks every ballot's identity,
support, weight and reason. The two fixtures prescribe a defeated exception and a successful
charter amendment, then probe their execution outcomes against a local HTTP canary. These are
scripted load scenarios, not model behaviour observations.

The five-member smoke run passed both scenarios, both executor checks and full chain recapture
of events, ballots and fees: `experiments/reports/scale-5-1789408051765/`. The completed 2,000-member
run is `experiments/reports/scale-2000-1789408328458/`. Deployment used 552,261,294 gas in total,
with a maximum of 6,673,062 gas in one transaction; `deployment-transactions.json` records each.

The exception received 1,600 Against and 400 For ballots and finished Defeated. Its executor
retry returned `target_not_allowlisted` and sent zero canary requests. The amendment received
1,200 For and 800 Against ballots and finished Executed. Its fetch reached the local canary once.
Every member voted on each proposal, with no missing or failed voting jobs. A separate read of
chain state reconstructed all 4,009 events, 4,000 ballots and 4,006 fee entries exactly. Total
runtime was 1,050,784 ms (17 minutes, 31 seconds rounded). The owned chain stopped cleanly, and
its state dump and all evidence remain in the run directory.

An earlier 2,000-member attempt stopped during deployment. Forge's bulk broadcast left the owned
Anvil stalled, then some transactions disappeared from its pending pool before confirmation.
The run retained its error and chain state. The corrected command uses one-second interval mining
and waits for each deployment transaction to succeed before sending the next. Gas checks remain
enabled. This does not change the running development chain.

Validation for these changes:

- Full `pnpm test`: 1,085 passed, 28 skipped. The later SDK lookup tests and scale fixture tests also passed (14 targeted tests).
- `pnpm typecheck`: passed after the deployment and SDK changes.
- Full `forge test` from `contracts/`: 109 passed, including partial initialization and activation guards.
- Model integration: 2 passed, 1 live-model test skipped. The real rejected-action executor probes and chain recapture still pass.
- Demo integration: passed all eight scripted scenarios and chain reconstruction.
- [Cost estimate for 2,000 actual model agents](scale-costs.md) documents current rates, assumptions and pending spending controls. The earlier five-agent record's inference total covers voting and is not a complete task-loop bill.

## Shared runtime controls

`InferenceScheduler` now wraps task, objection and voting providers before their calls reach the
transport. It reserves voting capacity, bounds concurrent calls and queued requests, and applies
the request deadline to queue time as well as inference. Each dispatched provider call gets at
most 60 seconds. Canceled task loops cannot spend their queued requests.

`inference.jsonl` records a start before dispatch and a completion afterward. A schema repair is
another recorded call. The Runner disables hidden OpenRouter transport retries so every HTTP
attempt has its own start record. Usage and billed cost are recorded when reported, with unknown
counts otherwise. Restarted runs reload their call count; starts interrupted before completion
still count toward the ceiling. A journal failure prevents further dispatch.

A tight-budget integration exposed task work consuming all 100 calls before voting opened.
The journal showed 100 task starts followed by three denied votes. The scheduler now reserves
20% of its call allowance for voting by default, separately from reserved concurrency. Task
loops stop when their share is consumed. The same integration then passed with its 100-call
limit intact, two inference slots, one tool slot and two voting-job slots.

Model report totals now use this journal-derived summary. Historical results keep their old vote
usage totals but are labeled incomplete. Claude usage includes reported cache input and billed
cost. Those initial controls bounded provider completions. The budget work below adds reservations
against the charter's token allocation and the operator's dollar allowance.

Shared work pools bound tool execution and voting jobs across proposals. Tool slots are acquired
before evaluating the charter, so waiting does not preserve a stale permission. Docker cleanup
finishes before the slot is released. Vote work is drained before the model record is assembled.
The Runner's environment check now uses the same 4,096-member maximum as the form and contracts.

Validation: full unit suite 1,105 passed, 28 skipped; typecheck passed. The final model integration
passed both scenarios, including explicit task/vote journal assertions, bounded runtime pools,
the 100-call ceiling with reserved voting calls, rejected executor probes and chain recapture.
Its optional live-model test remained skipped. Contract tests remain at 109 passing; this turn's
runtime changes did not change contract code.

## Token and dollar reservations

Every live model run now requires explicit token, dollar and model-price limits. A shared budget
owner reserves conservative input usage and the capped output before dispatch. It keeps 20% of
tokens and dollars for voting by default. When concurrent calls hold the remaining allowance,
queued work waits for refunds within its existing deadline. Only reported usage is refunded;
unknown and interrupted calls retain their reservations. Money accumulates in integer
nanodollars, with charges rounded up and allowances down.

Admission reads the current onchain charter after queueing. The lower of the charter's token
budget and the operator's ceiling applies to the whole fleet. A reported reservation overrun
stops new inference and fails the run, while already dispatched calls finish accounting. Input
reservations count serialized UTF-8 bytes, including the final strict schema, plus provider
framing headroom. This is an estimate, not proof of a provider's tokenization or bill.

OpenRouter requests carry maximum input and output prices, forbid per-request charges and
provider fallbacks, and require parameter support. Preflight reads the provider key's credit
limit before deployment and before agents start. It requires positive remaining credit no
higher than the configured run budget, no reset and BYOK usage included. No key settings are
changed. The Claude CLI cannot enforce the required output and price limits, so live budgeted
runs currently require OpenRouter. The form exposes the run allowance and each model's prices.

The attempt journal is flushed to disk before dispatch. An exclusive file lock prevents a
second coordinator from opening the same journal, and a scope file binds it to the chain,
ledger and task. Locks are never stolen automatically. Recovery requires confirming the old
owner has stopped, retaining the journal and removing only the stale lock. This is a single
accounting owner on a shared durable filesystem, not a distributed accounting service.

Focused tests cover concurrent reservations, refunds, voting's protected share, unknown usage,
interrupted starts, restart, lowered charters, cancellation, output-repair caps, price limits,
provider credit checks and journal ownership. The first onchain integration passed governance
and executor assertions, then failed chain recapture because a newly added export had not yet
been built when its CLI subprocess started. The workspace was rebuilt before the final rerun.
No paid model request or public-chain deployment was made during this budget work.

Validation: the full unit suite passed 1,135 tests, with 28 skipped. Ten focused checks passed
after the final form and preflight-test changes, including three new live-budget guard tests.
Typecheck and `git diff --check` passed. The final model integration passed both scenarios in
140.6 seconds, including fresh chain recapture, journal accounting and the rejected executor
probes. Its optional live-model test remained skipped. Contract code did not change in this work;
the earlier 109 contract tests remain the latest contract validation.

The live Runner form was checked in Chrome at `localhost:3100`: a zero-dollar budget disabled
Run and restoring the allowance enabled it. This inspection also exposed duplicate fixture
option values for model and scripted scenarios with the same name. Options now include both
kind and name, and the intended model selection was verified in the browser and a regression
test. No experiment was launched from the browser.

## Contract execution and incident write-up

`FleetExecutor` now executes exact, expiring, single-use contract permissions recorded through
Agora Governor and the timelock. `GovernedArtifactStore` has no alternate writer. Caller, task,
constitution version, target code, arguments, nonce, expiry, current task state, pause, escalation
and revocation are checked before the target call. The Governor submodule remains unchanged.
The SDK, manifests, deployment verification, record reconstruction and Runner expose these
permissions and distinguish successful governance from a successful resource write.

The five-member run `execution-5-1789411395881` verified actual rejected transactions for direct
operator writes, a defeated permission, substituted arguments and replay. The exact approved
publication succeeded once. Record reconstruction matched both governance and resource events.
The 2,000-member run `execution-2000-1789411525744` then passed the same checks with 4,000
ballots. The rejected proposal received 400 For and 1,600 Against; the approved proposal received
1,200 For and 800 Against. Every member voted. The rejected artifact stayed at revision zero,
and the approved artifact reached revision one. Reconstruction matched 4,009 governance events,
4,000 ballots, 4,012 fee entries and two resource events. Deployment used 109 transactions and
553,510,143 gas, with a maximum transaction of 6,673,062 gas. Runtime was 1,084,937 ms.
The owned Anvil stopped cleanly. A curated copy of the evidence is in `docs/evidence/`.

The full unit suite passed 1,156 tests, with 28 skipped. Typecheck passed. The final Forge run
passed 129 tests, including 20 execution tests. The model integration passed two scenarios;
its optional live-model test remained skipped. Runner browser verification caught and corrected
saved-record vote weights and confirmed the permission descriptions and artifact state. Large
collections now have search and 50-item pages; status lookup and balance requests are bounded.

`docs/blog-fleet-governance.md` is a bullet-point draft using the maintainer’s saved voice profile and
four posts read from ewakened.com. It cites Hugging Face and METR primary reports, explains the
exclusive access requirement, and separates the counterfactual from demonstrated behaviour.
`docs/execution-permits.md` documents the code and reproduction commands. Holding an action
before dispatch is demonstrated. A fleet-wide supervisor that terminates already running
external jobs is not implemented, and neither is production-proof isolation against the
incident's exploit chain.

## Remaining work

1. Measure a bounded live pilot using a dedicated capped provider key, normal task prompts and
   the complete usage journal. Size the charter, operator budget, voting window and concurrency
   from that evidence. Keep one coordinator and durable journal if tool workers move to other
   hosts; distributed inference coordinators need shared transactional accounting first.
2. Run the model experiment with normal task prompts and no prescribed votes. Preserve every
   outcome, including no attempted violation, approval, rejection and missing ballots. A
   successful scripted replay cannot stand in for this observation.
3. Verify the complete record through the Runner and Agora read side, including public reasons,
   chain reconstruction and the execution result. Audit the full objective again before marking
   it complete.

## Model task-loop publication

The normal loop now supports `publish_artifact`. The model names a workspace file; trusted code
reads its exact bytes, computes the digest and builds a permission for the configured store and
signer. A blocked request asks the model to propose, drop or escalate. The retry waits for that
exact recorded permission, so an unrelated decision cannot release it. Followers review and vote
without automatically publishing their own workspace copies. A publication task can continue
after tests pass, then stop on its actual resource write.

Permissions are stable across adapter restarts. Their nonces include the task, charter version
and digest; restarting does not refresh spent authority. Changed file bytes require new approval.
The gateway has a separate publication rule, so allowlisting the action class or approving an
ordinary tool descriptor cannot bypass the contract permission.

The three-member integration scenarios use scripted provider responses through the actual
TaskLoop, ToolRouter, worker, signer, Governor, timelock and artifact store. Approval published
once at task revision one. Rejection left revision zero. Direct signer calls confirmed that
bypassing the gateway still fails without approval or on replay. Both scenarios reconstructed
their governance events and resource state from chain data. Reports are in
[`docs/evidence/model-publication-20260914`](evidence/model-publication-20260914/approve.md).

The new `artifact-publication` model fixture supplies an ordinary coding and review task without
prescribing a ballot or outcome. No paid model calls were made for this integration. Measuring
actual model behaviour, restoring safe package installation, and completing the full read-side
audit remain outstanding. The original thread goal remains active.

Validation: the full unit suite passed 1,170 tests with 30 skipped. Typecheck and the production
build passed. The existing two model integration scenarios passed; the two new publication
scenarios then passed all assertions in a targeted rerun (185.7 seconds). The first attempt
stopped at a test diagnostic that tried to serialize a BigInt; the corrected diagnostic allowed
the contract bypass, changed-file and recapture assertions to run. Contract source was unchanged,
so the existing 129 passing contract tests remain the contract validation.

A read-only preflight also checked the existing OpenRouter key against a $1 pilot budget. It did
not meet the required non-resetting credit cap and accounting conditions. No credit settings were
changed and no inference was requested. A dedicated capped key is still needed for that pilot.

## Isolated package installation

Runner now supplies an isolated npm installer. The container has no external network, no mounted
host workspace or credentials, a read-only root filesystem and an unprivileged user. A small
loopback registry adapter requests downloads over framed stdin and stdout. The host broker checks
each exact HTTPS metadata and tarball URL against fresh ledger state. Downloads count against
the tool budget, and both allowed and blocked requests are logged.

Tarball URLs in registry metadata do not inherit the registry's permission. A denied download
stops the install and returns the actual blocked `network_fetch` to the task loop. The model can
propose, drop or escalate that request. Retrying the original install waits for its matching
recorded grant, and every download is checked again. A changed query, an old constitution-version
exception, a pause or an escalation cannot reuse the earlier allow result.

Package lifecycle scripts are disabled and host npm remains unavailable. Direct URL, git and
local path dependencies are unsupported. Successful dependencies are kept in a dedicated volume
and mounted read-only into the test sandbox. Failed installs preserve previous dependencies.
Cancellation and timeout remove the named container and candidate volume; Runner cleans up the
retained volume after its tool work drains.

The first integration run caught npm rejecting the same empty config file for user and global
configuration. Separate empty files fixed it. The next run exposed Docker automatic removal
racing explicit cleanup after cancellation. The installer now owns removal explicitly. The
final eight Docker checks passed, including transitive registry dependencies, rejected downloads,
redirects, a direct egress canary, lifecycle scripts, cancellation, timeout and inspection for
leftover owned resources. These checks use real npm and Docker with test ledger and HTTP responses.

The full unit suite passed 1,183 tests with 38 skipped. Typecheck and the production build passed;
the build retains the existing `spawn-run.ts` import-meta warning. The 52 focused broker and
task-loop tests passed. Bundled evidence checksums and available local captures still match.
Contract source, including Agora Governor, was unchanged. No paid model calls were made.

The final model integration passed all four scenarios in 312.5 seconds: rejected fetch,
approved publication, rejected publication and a malformed voter that casts no ballot. Its
optional live-model test remained skipped. The owned test chain and temporary deployment
directory were cleaned up afterward.

The [installer guide](package-installation.md) records the supported package types, resource
bounds and remaining trust assumptions. There is no hard quota on the named dependency volume,
crash janitor, production isolation proof or fleet-wide cancellation of external workloads. A
new ledger read prevents subsequent requests; it cannot recall an already dispatched HTTP call.

## Public record reconstruction

Capture now rebuilds proposal capabilities, outcomes and identities from the actual Governor
calldata, public description, ledger trace and registry. It no longer retains a saved permission
or proposer identity as evidence. A description that fails verification stays in the raw events
but supplies no verified action or permission. Proposal discovery and state read failures abort
capture instead of silently falling back to the saved proposal list.

Ballot reconstruction also matches both the proposal and voter before retaining a local model
response. Previously, two proposals under the same fixture could share that metadata. Actual
support, public reasons, transaction hashes and agent identities now come from their matching
chain evidence. Cached ballots absent from chain lose those assertions. Local expectations,
test results, jobs and inference responses remain explicitly offchain bookkeeping.

The approval integration removes the saved proposal and execution sections. The rejection
integration corrupts the saved outcome, summary, proposer and permission. Both corrupt saved
voter identities and reasons. The capture CLI then recovers the exact permission, actual votes,
outcome and resource state from fresh Anvil deployments. Both cases passed in 187.2 seconds,
using scripted provider responses through the normal task loop and real contract transactions.

The full unit suite passed 1,193 tests with 38 skipped. Typecheck and the production build passed.
The existing build warning about `spawn-run.ts` remains. Evidence checksums and available local
captures still match. Contract source was unchanged; the previous 129 passing contract tests
remain its latest validation. No paid model calls were made.

Chrome inspection of `execution-2000-1789411525744` confirmed Runner labels the unavailable chain
and saved capture, displays both exact permissions and public reasons, and shows artifact
revision zero after rejection and revision one after approval. This is the saved scripted run,
not a new model experiment. The [reconstruction guide](record-reconstruction.md) explains what
the command verifies and what it retains as local bookkeeping.

The cost guide and bullet-point blog now include Muse Spark Contributor estimates for 20, 100
and 500 calls per member: $32, $160 and $800 respectively for 2,000 agents at the stated token
averages. The dedicated capped key required for the measured live pilot is still pending.

The separate Agora browser audit remains incomplete. Its local Next development container was
repeatedly killed at its 6 GiB memory limit while compiling proposal pages. Enabling Next's
Webpack memory option with a 4 GiB Node heap still produced a recorded Docker OOM event. A 3 GiB
heap trial also reached the container limit without rendering the page. Those unproven settings
were reverted. The existing Anvil, database and indexer were not restarted. A larger development
VM or a verified reduction in the UI's compilation footprint is still needed for this audit.

## Archive availability and chain comparison

The Agora archive reader now preserves the difference between an empty record and unavailable
evidence. Its vote API returns HTTP 503 with a plain unavailable message for missing objects,
failed reads or malformed NDJSON. It no longer treats a partial file as a complete ballot list.
An explicitly empty file remains readable, with wording that describes the archive rather than
asserting that the chain has no votes.

Fleet proposal lists reject missing or malformed archive files too. A proposal detail lookup
can use a valid result from another configured source. When no source returns the proposal,
failed reads remain errors. Only missing objects across all sources mean not found. Twelve
tests passed against the actual patched reader and vote route in the built Agora image, using
a local HTTP archive server inside a container with no external network.

A separate read compared both five-member demo archives with the still-running local chain.
The executed proposal had three For and two Against ballots; the defeated proposal had two
For and three Against. All ten ballots matched on voter, support, weight, public reason,
transaction, block and chain ID. These are existing demo records, not a new model run. The
bundled evidence checksums and available local captures also still match.

The tenant's transparency notice now distinguishes approval, execution, the contract artifact
store and the runtime gateway. It no longer says all enforcement happens offchain. The health
check consumes the full page response before exiting, avoiding cancellation of a successful
streamed render. The Docker build now reuses installed dependencies when tenant copy or runtime
patches change. All changes apply outside the pinned upstream Governor source.

The Agora detail-page browser audit still did not complete. With a 7 GiB container, a 3 GiB
V8 heap failed with a recorded JavaScript heap exhaustion. A 4 GiB heap served the list but
triggered Next's memory restart during detail compilation. These trials were reverted; the
tested archive changes do not claim to fix compilation. Anvil, Postgres and DAO Node kept their
original container identities and start times throughout the audit.

The read-only $1 OpenRouter preflight still rejects the available key because it does not meet
the required non-resetting credit cap and accounting conditions. No paid model calls were made
and no provider credit settings were changed. The dedicated capped key remains necessary for
the measured live pilot.
