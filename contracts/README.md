# Fleet Governance contracts

Solidity contracts for Fleet Governance v1: a fixed set of agents governs its own task charters
through an unmodified [Agora Governor](https://github.com/voteagora/agora-governor), wired up
through that governor's hook system rather than a fork. See `../docs/spec.md` for the full
specification and `../docs/compatibility-notes.md` for every compatibility issue found while
building this and how it was resolved.

## The contracts

### FleetRegistry

Immutable membership and public manifests for one fleet deployment, with 2 to 4,096 members.
The constructor commits to the member count, an ordered hash of all addresses and agent manifests,
and the fleet manifest. The initializer loads the committed roster in batches of at most 32
members and 8,192 manifest bytes. No address has membership authority until the complete roster
matches the commitment. Every manifest is stored and emitted in full. There is no admission, rotation, or
removal path anywhere in `FleetRegistry`: a different fleet, or a fleet whose membership changes,
is a different deployment of the whole sequence below, not a call into this one. Every other
contract in this repository treats `FleetRegistry.isMember` as the single source of truth for who
belongs to the fleet.

### FleetVotes

An ERC-20 votes token (`ERC20Votes`, timestamp-clocked) that mints exactly one unit (1e18) to each
member of a sealed `FleetRegistry` through setup batches of at most 64 members. The initializer
cannot choose recipients or amounts, and minting ends permanently after the last member.
Public delegation and hook activation remain disabled until the supply is complete. `_update`
reverts on every non-mint transfer, and `_approve` reverts unconditionally, so the token can never
move after the fleet is stood up. Delegation is restricted to members delegating to themselves or
to another member (`_delegate` checks `registry.isMember` on both ends), so voting power always
traces back to a real agent seat, never to an outside address.

### TaskLedger

The public record of tasks, charters, and fleet decisions. Holds no funds. An `operator` opens
tasks with a charter and a lifetime; the fleet's `timelock` (and only the timelock, reachable only
through a successful governor proposal and vote) records decisions against an open task through
`recordDecision`; a `guardian` can pause and unpause the ledger and cancel queued timelock
operations, and can do nothing else. Stopping a task is a `STOP_TASK` decision the fleet votes for,
or the operator's `completeTask`, and the guardian can reach neither. A recorded decision means the
fleet decided by vote, not that anything downstream obeyed it: offchain enforcement of a decision is
out of scope for this contract.

### FleetHook

Every fleet-specific governance rule, attached to the unmodified `AgoraGovernor` through its hook
system (permission mask `0x22C0`: `beforePropose`, `afterPropose`, `beforeVote`,
`beforeVoteSucceeded`) instead of by forking the governor. `beforePropose`/`afterPropose` restrict
proposals to a single `TaskLedger.recordDecision` call against an open, unexpired task with the
right charter version; `beforeVote` restricts voting to members with nonzero delegated voting power
at the proposal snapshot, which is not the same as a nonzero balance (a member who delegated its
unit away still holds the balance and cannot vote); `beforeVoteSucceeded` implements the fleet's
for-only-quorum rule (For must reach quorum on its own and exceed Against, Abstain does not count
toward passing). The contract is deployed via a mined CREATE2 salt so its address carries exactly
the permission bits the governor's hook dispatcher checks.

`AgoraGovernor` and `TimelockController` themselves are vendored, unmodified upstream code (see
Pins, below); this repository only wires them together and layers `FleetHook` on top.

### FleetExecutor and GovernedArtifactStore

`FleetExecutor` requires a settled, exact permission before making a zero-value contract call.
It binds the agent, task, charter version, target code, calldata, nonce and expiry, and checks
current pause, task, escalation and revocation state. Successful permissions are consumed once.
The guardian can revoke a permission but cannot grant one.

`GovernedArtifactStore` accepts publication only from that executor. It records a task's canonical
artifact digest and revision. There is no direct operator or guardian write path. See
[execution permissions](../docs/execution-permits.md) for the scope and reproduction commands.

## Deployment sequence

`contracts/src/deploy/FleetDeployer.sol` (a library, `FleetDeployer.deploy`) runs the full sequence
once, shared by the Foundry script and the test fixture:

1. `FleetRegistry` commits the roster, then seals it through bounded registration transactions.
2. `FleetVotes` initializes one unit per member, delegated to itself, through bounded mint transactions.
3. `TimelockController` (no initial proposers or executors; the deployer is the initial admin).
4. `TaskLedger` (bound to the timelock, the configured operator, and the configured guardian).
5. `FleetHook`, at a CREATE2 salt mined by `contracts/src/deploy/HookMiner.sol` so the deployed
   address's low 16 bits equal `FleetHook.PERMISSION_MASK` (`0x22C0`).
6. `AgoraGovernor`, deployed via an inline-assembly `create` over its creation code plus
   ABI-encoded constructor arguments (needed because the `IHooks` type our files import is not the
   same nominal type the vendored governor's constructor declares; see
   `docs/compatibility-notes.md`, Task 5).
7. `hook.initialize(governor)`, checking the sealed registry and complete token supply before binding the governor.
8. `timelock.grantRole` three times (`PROPOSER_ROLE`, `EXECUTOR_ROLE`, `CANCELLER_ROLE` to the
   governor) plus once more (`CANCELLER_ROLE` to the guardian), then
   `timelock.renounceRole(DEFAULT_ADMIN_ROLE, deployer)`, so after deployment only the governor (by
   way of a successful proposal and vote) and the guardian (cancellation only) can act on the
   timelock, and no EOA holds admin rights over it.
9. Deploy `FleetExecutor` and `GovernedArtifactStore`, making the executor the store's only writer.

## Running the tests

```bash
cd contracts
forge test
```

`forge test` prints benign `solar` ("file not found") lines to stderr on every run; this is
Foundry 1.7.1's bundled linter failing to resolve the vendored submodule's own internal remapping
while resolving the import graph for lint purposes, not a compilation or test failure (see
`docs/compatibility-notes.md`, Task 1). Judge success by the exit code and the `[PASS]`/`[FAIL]`
summary, not by scanning output for the word "error".

## Deploying locally

The commands below were run against a local Anvil on **port 8599**, and are exactly what produced
the manifest and ABIs committed in this repository. The Docker Compose stack for another
workstream in this project already uses port 8545, so the deploy scripts here default to nothing
and always take `--rpc-url` explicitly; use 8599 (or any other free port) to avoid colliding with
that stack.

```bash
anvil --block-time 2 --port 8599 --silent &

cd contracts
FLEET_DEPLOY_CONFIG=../deployments/configs/local-5.json \
FLEET_DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
forge script script/DeployFleet.s.sol --rpc-url http://127.0.0.1:8599 --broadcast -vv

jq . ../deployments/31337/latest.json

FLEET_MANIFEST=../deployments/31337/latest.json \
forge script script/VerifyDeployment.s.sol --rpc-url http://127.0.0.1:8599 -vv

bash script/export-abi.sh

kill %1
```

`FLEET_DEPLOYER_KEY` above is Anvil's well-known default account 0
(`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`); never use it, or any other Anvil default key, on a
network that holds anything of value. `deployments/configs/local-5.json` uses Anvil's default
accounts 1 through 5 as the five fleet members, account 6 as the operator, and account 7 as the
guardian.

The deploy script writes two byte-identical files, `deployments/<chainId>/latest.json` (the pointer
the next deployment overwrites) and `deployments/<chainId>/<deploymentTimestamp>.json` (the
archive), and prints the eight contract addresses. Setting `FLEET_MANIFEST_OUT` redirects the manifest
to that path and skips the archive, for throwaway runs.

`VerifyDeployment.s.sol` re-reads a manifest and asserts every post-condition the deployment
sequence promises: hook, governor, registry, ledger, and token cross-wiring; the hook's permission
bits; admin and manager zeroed; timelock roles and minimum delay; the ledger's operator, guardian,
and maximum task lifetime; the registry's member list against the manifest's; token supply and
per-member voting power; governor parameters; and the on-chain codehash of all eight contracts. It
prints `VERIFIED` when they all hold. Every check either passes or reverts with a message naming it.
The one check with a timing precondition, per-member voting power, needs the chain's clock to have
moved past the block the deployment landed in; if it has not, the verifier reverts with
`clock has not advanced past deployment; retry in a moment` rather than skipping the check, so
`VERIFIED` never means "everything except that one". See `docs/compatibility-notes.md` for the addresses this exact run produced, why they
are deterministic for a fresh Anvil with this deployer, and what the broadcast looked like under
`vm.startBroadcast` for the governor's `create` and the hook's CREATE2 deployment.

## Exporting ABIs

```bash
cd contracts
bash script/export-abi.sh
```

Writes `FleetRegistry.json`, `FleetVotes.json`, `FleetHook.json`, `TaskLedger.json`,
`AgoraGovernor.json`, `TimelockController.json`, `FleetExecutor.json`, and `GovernedArtifactStore.json` (each just the `abi` array, via `jq`) to
`packages/abi/abis/`, building first if needed.

## Contract sizes

`forge build --sizes`, filtered to the contracts this repository deploys:

| Contract | Runtime bytes | Initcode bytes | Runtime headroom | Initcode headroom |
| --- | ---: | ---: | ---: | ---: |
| AgoraGovernor | 23,005 | 26,483 | 1,571 | 22,669 |
| FleetHook | 10,821 | 11,666 | 13,755 | 37,486 |
| FleetRegistry | 3,709 | 4,789 | 20,867 | 44,363 |
| FleetVotes | 8,172 | 9,593 | 16,404 | 39,559 |
| TaskLedger | 7,048 | 7,510 | 17,528 | 41,642 |
| TimelockController | 6,550 | 7,468 | 18,026 | 41,684 |
| FleetExecutor | 4,350 | 5,167 | 20,226 | 43,985 |
| GovernedArtifactStore | 808 | 994 | 23,768 | 48,158 |

Measured from the current Foundry build on September 14, 2026. All eight contracts are below
the 24,576-byte runtime limit. Agora Governor has the least runtime headroom at 1,571 bytes.

## Pins

`docs/compatibility-notes.md` and every manifest's `pins` object record the exact vendored commits
this repository builds against: `agora-governor` at `11a11641ce1f4f691c300d530eae3c7203593b85`,
its nested `openzeppelin-contracts` at `3d139e998b9843179d72b28a3264834b01baf160`.
