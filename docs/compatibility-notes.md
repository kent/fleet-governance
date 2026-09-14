# Compatibility notes

## Task 1: Agora submodule remapping (`contracts/remappings.txt`)

The context-scoped remapping from the brief works as written and is the form kept in
`contracts/remappings.txt`:

```
lib/agora-governor/:src/=lib/agora-governor/src/
```

With this line, `solc` resolves Agora's internal `src/...` imports (for example
`lib/agora-governor/src/AgoraGovernor.sol` importing `src/interfaces/IHooks.sol`) without
error, and `forge test` compiles and runs `contracts/test/unit/AgoraCompiles.t.sol`
successfully, proving `AgoraGovernor` builds through the submodule. The global fallback
(`src/=lib/agora-governor/src/`) was also tried and behaves identically for compilation and
tests; the context-scoped form was kept because it does not risk silently redirecting a
future accidental `import "src/..."` inside our own `contracts/src` to the vendored
submodule.

### Separate issue: Foundry 1.7.1's automatic lint pass fails on both remapping forms

Independent of which of the two remapping forms above is used, plain `forge build` (no
flags) failed with exit code 1:

```
Compiler run successful!
error: file src/interfaces/IHooks.sol not found
  --> lib/agora-governor/src/libraries/Hooks.sol:4:22
    |
4   | import {IHooks} from "src/interfaces/IHooks.sol";
    |                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^

error: file src/interfaces/IHooks.sol not found
   --> lib/agora-governor/src/AgoraGovernor.sol:16:22
    |
16  | import {IHooks} from "src/interfaces/IHooks.sol";
    |                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^

error: file src/libraries/Hooks.sol not found
   --> lib/agora-governor/src/AgoraGovernor.sol:17:21
    |
17  | import {Hooks} from "src/libraries/Hooks.sol";
    |                     ^^^^^^^^^^^^^^^^^^^^^^^^^^

Error: Lint failed

Context:
- solar run failed
```

Note that `solc` itself already reported `Compiler run successful!` immediately above those
errors, and `forge build --sizes` (before it aborted) had already listed `AgoraGovernor` at
its correct compiled size. The failure comes from `forge`'s bundled linter (`solar`), which
Foundry 1.7.1 runs automatically as part of `forge build` (`[lint] lint_on_build` defaults to
`true`). `solar` cannot resolve the same `src/...` remapping that `solc` resolves without
issue, in either the context-scoped or the global form; this reproduces identically with
both, so it is a `solar` limitation on this project layout, not a defect in the remapping
itself.

**Scoping tried first, before disabling anything.** Per review, I tried to scope the linter
away from the submodule instead of disabling it project-wide, with `lint_on_build` left at
its default (`true`):

- `[lint] ignore = ["lib/**"]` and `[lint] ignore = ["lib/agora-governor/**"]`, checked
  against `forge lint --help` and the resolved config (`forge config`, which lists `ignore`
  under `[lint]`). Both left `forge lint` (and `forge build`) failing with the identical
  `solar run failed` / "file src/interfaces/IHooks.sol not found" error.
- `forge lint src test` (passing our own directories directly as `PATH` arguments, which
  `forge lint --help` documents as overriding the `ignore` project config). Still failed the
  same way, because our own `test/unit/AgoraCompiles.t.sol` imports `AgoraGovernor`, so
  `solar` must still resolve the whole import graph reachable from our file to lint it, and
  that graph runs straight into `lib/agora-governor/src/AgoraGovernor.sol`'s own `src/...`
  imports.

Conclusion: `ignore` (by path glob, or by restricting the `forge lint` `PATH` arguments to
only our own files) only controls which files get lint *rule* findings reported. It does not
stop `solar` from needing to resolve every file reachable by import from whatever it is
linting, which includes the submodule as soon as anything imports `AgoraGovernor`. There is
no config that scopes `solar`'s import resolution itself away from `lib/`, so scoping is not
viable here; disabling is the only working option.

**Fix applied:** added to `contracts/foundry.toml`, with a comment recording why:

```toml
# solar (forge lint) cannot resolve the submodule remapping; see docs/compatibility-notes.md
[lint]
lint_on_build = false
```

This is one section beyond the brief's verbatim `foundry.toml` content, added because
without it `forge build` (the project's most basic command, used by every later task) always
fails on this vendored submodule regardless of remapping choice. With `lint_on_build = false`,
`forge build` and `forge build --sizes` compile cleanly with exit code 0 and no error output.
Note this also disables lint-on-build for our own future `contracts/src` files, not just the
submodule; there is no per-path way to disable it only for `lib/` (see above), so anyone
wanting lint feedback on our own contracts should run `forge lint src test` explicitly (or
their editor's Solidity lint integration) rather than relying on `forge build`.

**Known residual noise on `forge test`, and why it is safe to ignore:** `forge test` still
prints the same non-fatal `solar` "file not found" lines to stderr on every run, for example:

```
error: file src/interfaces/IHooks.sol not found
   --> lib/agora-governor/src/AgoraGovernor.sol:16:22
```

This is not gated by `[lint] lint_on_build`: it stayed `false` throughout and `forge test`
printed the lines anyway. I also tried `FOUNDRY_LINT_ON_BUILD=false forge test` (env var
override) and checked `forge test --help` / `forge build --help` / `forge --help` for a
`--no-lint`-style flag; none exists in Foundry 1.7.1, and the env var did not change the
output. There is no available config, flag, or env var that removes this noise from `forge
test` in this Foundry version.

It does not affect correctness: `forge test`'s exit code and its `[PASS]`/`[FAIL]` per-test
results are unaffected, and the full suite consistently exits `0` with `3 passed; 0 failed`
across repeated runs (clean and cached). **Any CI or script that runs `forge build` or
`forge test` in this repository must judge success by the process exit code, never by
scanning stdout/stderr for the strings "error" or "not found"** (or any other substring
match), because `solar`'s non-fatal diagnostic noise will produce false failures under that
approach. Treat the lines above as benign tool noise from `solar`, not a real compilation or
test failure, unless a later Foundry release changes this behavior.

## Task 3: solc warning 5740 (Unreachable code) from vendored `ERC20.sol`

`FleetVotes._approve` unconditionally reverts by spec, which makes solc's static analysis flag
the `return true;` after the internal `_approve` call inside the vendored, unmodified
`ERC20.approve()` (`lib/agora-governor/lib/openzeppelin-contracts/contracts/token/ERC20/ERC20.sol`)
as unreachable (warning 5740); since the cause is our required revert, not a defect in the
submodule, it is suppressed via `[profile.default] ignored_warnings_from =
["lib/agora-governor/lib/openzeppelin-contracts"]` in `contracts/foundry.toml` (confirmed
honoured by Foundry 1.7.1, verified with `forge config`), rather than by changing the revert
behavior or editing vendored code.

## Task 5: HookMiner, FleetHook, and a cross-context `IHooks` type mismatch

### Contract sizes

`forge build --sizes` after adding `FleetHook`, run from `contracts/`:

```
| Contract      | Runtime Size (B) | Initcode Size (B) | Runtime Margin (B) | Initcode Margin (B) |
| AgoraGovernor | 23,005           | 26,483             | 1,571               | 22,669               |
| FleetHook     | 10,002           | 10,833             | 14,574              | 38,319               |
| FleetRegistry | 1,422            | 3,284              | 23,154              | 45,868               |
| FleetVotes    | 7,149            | 10,969             | 17,427              | 38,183               |
| TaskLedger    | 6,616            | 7,078              | 17,960              | 42,074               |
```

`AgoraGovernor` is unchanged at 23,005 bytes runtime, as expected since it is vendored and
untouched. `FleetHook` is 10,002 bytes runtime, well under the 24,576-byte limit.

### Deviation 1: a contract's `public constant` is not reachable as `ContractName.CONSTANT`

The brief's `FleetHook.t.sol` mines the CREATE2 salt with
`HookMiner.find(address(this), FleetHook.PERMISSION_MASK, ...)`, reading the constant directly
off the contract type before any instance exists (the salt search needs the flags value to look
for). This does not compile: `ContractName.member` syntax only resolves the special `type(X)`
members (`creationCode`, `runtimeCode`, `name`, `interfaceId`) and nested declarations (enums,
errors, events, by name), plus whatever a *library* exposes this way, because a library's
constants have no per-instance storage. A regular contract's `public constant`, by contrast, is
exposed only through the getter function generated on a deployed instance; solc rejects
`ContractName.CONSTANT` for it with `Member "PERMISSION_MASK" not found or not visible after
argument-dependent lookup in type(contract FleetHook)`. Confirmed in isolation with a minimal
contract unrelated to Agora or IHooks: a plain `contract Plain { uint160 public constant
FOO_BAR = 0x22C0; }` fails the same way from another file, while the identical constant declared
in a `library` compiles and resolves fine.

Fix applied in `contracts/test/unit/FleetHook.t.sol`: both `HookMiner.find(...)` calls now pass
the literal `0x22C0` (documented in the brief's own interface block as
`PERMISSION_MASK = 0x22C0`) in place of `FleetHook.PERMISSION_MASK`, with a comment explaining
why. `FleetHook.PERMISSION_MASK` itself is unchanged and still `public`; the deviation is only in
how the test reads the value before deployment.

### Deviation 2: `IHooks` imported by our files is not the same nominal type `AgoraGovernor` expects

The brief's `FleetHook.t.sol` builds the governor with
`new AgoraGovernor(15, 120, 1e18, 6000, IVotes(address(token)), timelock, address(0), address(0),
IHooks(address(hook)))`. This fails to compile:

```
TypeError: Invalid type for argument in function call. Invalid implicit conversion from
contract IHooks to contract IHooks requested.
```

Both sides of the message really do say "IHooks"; solc is reporting two distinct nominal types
that happen to share a name. Root cause, confirmed with about a dozen minimal repros (isolated
from FleetHook and from Agora entirely): `AgoraGovernor.sol` and `Hooks.sol` live inside
`lib/agora-governor/` and import `IHooks` as `import {IHooks} from "src/interfaces/IHooks.sol";`,
resolved through the context-scoped remapping (`lib/agora-governor/:src/=lib/agora-governor/src/`
in `contracts/remappings.txt`, itself redundant with a remapping Foundry auto-detects from the
submodule's own `foundry.toml` `src = 'src'`, confirmed by testing with that manual line removed:
identical failure). Context-scoped remappings apply only when the *importing file* is inside the
context directory, by design, so no import written in our own `contracts/src` or `contracts/test`
files (regardless of the exact string used: `agora-governor/src/interfaces/IHooks.sol`,
`lib/agora-governor/src/interfaces/IHooks.sol`, or even the literal `src/interfaces/IHooks.sol`
under a same-prefix global remapping) can ever resolve through that context rule. Every import
route available to us produces a second, separate parse of the identical file, and solc's nominal
typing treats the two `IHooks` declarations as different types. This is not fixable from the
consumer side by changing `contracts/remappings.txt`: every combination tried (global-only
form, context-only form, both together, `auto_detect_remappings = false`) reproduced the same
error for a value built from *any* import reachable from outside `lib/agora-governor/`. It is
also not specific to `FleetHook`: a two-line repro with no interface inheritance at all (just
`new AgoraGovernor(..., IHooks(someAddress))` from a throwaway contract) fails identically, so
this would block any future code (deployment scripts, Task 7's governor wiring) that constructs
`AgoraGovernor` with a hook address from outside the submodule.

Two call sites were affected and fixed differently, both confined to files already in this
task's staged set; `contracts/remappings.txt` and `contracts/foundry.toml` are untouched:

- **`FleetHook`'s own constructor** called `Hooks.validateHookPermissions(IHooks(address(this)),
  getHookPermissions())`, which has the same problem (the library function's `self` parameter is
  typed with the submodule's `IHooks`). Fixed by inlining the equivalent bit-check directly in
  `FleetHook.sol` (`_validateHookPermissions`, private, called from the constructor): it compares
  `getHookPermissions()` against `uint160(address(this))` masked with each of `Hooks`'s 16 flag
  constants (plain `uint160` values, not interface-typed, so they have no cross-context identity
  problem) and reverts with `Hooks.HookAddressNotValid(address(this))` on any mismatch, exactly
  the check `validateHookPermissions` performs. Behavior is identical; only the call mechanism
  changed.
- **The test's `new AgoraGovernor(...)`** needed an actual `IHooks`-typed argument, which has no
  fix at the Solidity source level. Fixed by deploying with forge-std's `deployCode(string,bytes)`
  (`StdCheats`, inherited by `Test`) instead of `new`: it reads `AgoraGovernor`'s compiled creation
  code by artifact name (`"AgoraGovernor.sol:AgoraGovernor"`) and appends ABI-encoded constructor
  arguments, bypassing Solidity's constructor-argument type-checking entirely. This is
  byte-for-byte equivalent to the `new` call it replaces: contract and interface type constructor
  arguments are ABI-encoded identically to `address`, so `abi.encode(..., address(hook))` produces
  the same calldata `IHooks(address(hook))` would have. `IVotes` and `TimelockController` were
  left in their prior form in every other respect (both resolve through the *same*
  `@openzeppelin/contracts/=...` remapping for every importer, submodule and consumer alike, so
  they do not have this problem); the `IVotes`/`IHooks` imports became unused after the change and
  were removed from the test file to keep the build warning-free.

**Handoff to later tasks:** any future code that constructs `AgoraGovernor` (or calls anything
else whose signature carries the submodule's `IHooks`, `Hooks.Permissions`, or similar
context-resolved types) from a file outside `lib/agora-governor/` will hit this same error and
need the same `deployCode`-style workaround, or a structural fix to how the submodule is vendored
(for instance, consuming it without a nested `foundry.toml` of its own, so there is only one
resolution context for its internal imports). Flagging this explicitly for whoever deploys the
real governor.

### Task 8: hook revert data is not preserved through `Hooks.callHook` (confirmed live)

Read directly from `lib/agora-governor/src/libraries/Hooks.sol`: both `callHook` (used for
`beforePropose`, `afterPropose`, `beforeVote`) and `staticCallHook` (used for
`beforeVoteSucceeded`) do

```solidity
if (!success) revert HookCallFailed();
```

`HookCallFailed()` is declared with **no parameters** (`error HookCallFailed();`), and the
`returndata` from the failed call is never read on the revert path, only on success. There is no
ERC-7751 `WrappedError(target, selector, reason, details)` construction anywhere in this pinned
fork, no try/catch around the hook call, and no other wrapping layer in `AgoraGovernor.sol`. This
means a revert from inside `FleetHook` (for example `NotMember(address)` or
`CharterVersionMismatch(uint32,uint32)`) is **not preserved** in any form once it crosses
`Hooks.callHook`/`staticCallHook`: the governor's own revert carries only the bare
`Hooks.HookCallFailed` selector, and the original error's selector, arguments, and reason string
are all discarded. Code that needs to distinguish *why* a proposal or vote was rejected by
`FleetHook` cannot do so by inspecting the governor call's revert data; it would need to
simulate the hook call directly (e.g. `eth_call` against `FleetHook` with the same arguments) to
recover the real error.

**Confirmed live in Task 8's integration tests.** `AdmissionTest.test_ImpostorCannotPropose`
(`contracts/test/integration/Admission.t.sol`), run with `-vvvv`, shows the trace directly:

```
├─ [..] FleetHook::beforePropose(outsider, ...)
│   ├─ [..] FleetRegistry::isMember(outsider) [staticcall]
│   │   └─ ← [Return] false
│   └─ ← [Revert] NotMember(0x6AB133Ce3481A06313b4e0B1bb810BCD670853a4)
└─ ← [Revert] HookCallFailed()
```

`FleetHook.beforePropose` reverts with `NotMember(address)`, carrying the impostor's address as
data, but `AgoraGovernor.propose` (by way of `Hooks.callHook`) re-reverts with the bare,
zero-argument `HookCallFailed()`. The inner selector and argument are fully discarded, not
bubbled or wrapped as ERC-7751 `WrappedError` data, matching the source reading above. Because of
this, Task 8's tests assert `Hooks.HookCallFailed.selector` (not the specific `FleetHook` error)
for every rejection that originates inside the hook, and rely on the trace comment, not on
`vm.expectRevert` data, to record which inner error actually fired.

### Fix round 1: `decodeAction` minimum-length guard

`decodeAction` now checks `data.length >= 4 + 6 * 32` (the selector plus the six-word static head
of `(uint256, uint8, uint32, bytes32, string, string)`) before calling `abi.decode`, because a
right-selector tail shorter than that static head previously reached `abi.decode` and reverted
with empty return data instead of `FleetHook.MalformedCalldata()`; deeper structural malformation
that still passes this length check, such as internally inconsistent dynamic-type offsets in an
otherwise long-enough tail, still reverts through the ABI decoder without a custom error, but
either path rejects the proposal (`beforePropose` never returns successfully either way).

## Task 9: `HookMiner.find`'s unfreed memory accumulates across sequential internal calls

`contracts/test/integration/BallotProfiles.t.sol`'s `test_EffectiveYesCountForOtherFleetSizes`
calls `_checkFleet` three times, once per fleet size (3, 7, 10), and each call deploys a fresh
fleet through `FleetDeployer.deploy`, which calls `HookMiner.find` to mine a CREATE2 salt for
`FleetHook`. `HookMiner.find` loops up to `MAX_ITERATIONS` (500,000) calling
`computeAddress`, which does `abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)` on
every iteration. Solidity's memory allocator is a simple bump allocator: it never frees the
scratch space a loop iteration's `abi.encodePacked` used, so memory grows by roughly one word
per iteration for as long as the loop runs, and EVM memory-expansion cost grows quadratically
in the number of words touched.

Written exactly as the brief's Step 1 gives it, with `_checkFleet` `internal` and all three
calls inside one `function ... public` test body, this is one EVM call frame for the whole
test, so the memory each mining round leaves behind is never reclaimed before the next round
starts. `_checkFleet(3, 2)` and `_checkFleet(7, 5)` passed, but the third round,
`_checkFleet(10, 6)`, failed deterministically (same result on a rerun with no code changes):

```
[FAIL: EvmError: MemoryOOG] test_EffectiveYesCountForOtherFleetSizes() (gas: 1073720760)
```

with `-vvvv` showing the trace stop right after the fleet's `TaskLedger` deploys, inside
`FleetDeployer.deploy`'s call to `HookMiner.find` (a `view` library call, inlined into the same
frame, so it has no separate trace entry of its own):

```
├─ [1325490] → new TaskLedger@0xe8dc788818033232EF9772CB2e6622F1Ec8bc840
│   └─ ← [Return] 6616 bytes of code
└─ ← [MemoryOOG] EvmError: MemoryOOG
```

Isolating `_checkFleet(10, 6)` alone in the test body (no prior `_checkFleet` calls in the same
frame) passed cleanly at 63,107,152 gas, confirming the failure is the accumulation across
calls sharing one frame, not anything about `n = 10` itself.

**Fix:** changed `_checkFleet` from `internal` to `external` and call it as
`this._checkFleet(...)` from the test body. A `this.` call is a real `CALL`, which starts a new
EVM call frame with fresh, empty memory, so each fleet size's mining round no longer inherits
memory left behind by the previous one. No production contract changed;
`contracts/src/deploy/HookMiner.sol` and `contracts/src/deploy/FleetDeployer.sol` are unmodified.
After the fix, both `BallotProfilesTest` tests pass, still as exactly two `test_`-prefixed
functions:

```
Ran 2 tests for test/integration/BallotProfiles.t.sol:BallotProfilesTest
[PASS] test_AllBallotProfilesMatchForOnlyRule() (gas: 631451888)
[PASS] test_EffectiveYesCountForOtherFleetSizes() (gas: 601208324)
Suite result: ok. 2 passed; 0 failed; 0 skipped; finished in 354.29ms (431.46ms CPU time)
```

**Handoff:** any future test (or script) that calls `FleetDeployer.deploy` more than once or
twice inside a single call frame (a loop, or several sequential calls in one function body, as
here) risks the same cumulative `MemoryOOG`, purely from how many mining rounds have already run
in that frame; the fix is the same, put each `FleetDeployer.deploy` call (by way of `HookMiner.
find`) behind a real external call boundary so its mining memory does not survive past that call.
A structural fix at the source would be to change `HookMiner.computeAddress` to write into a
fixed, reused scratch buffer instead of a fresh `abi.encodePacked` each iteration, which is out
of this task's scope (`contracts/src/deploy/HookMiner.sol` was not touched).

## Task 12: Deploy script, verifier, ABI export, local Anvil run

### `HookMiner.find` rewritten to be allocation-free

Task 9 (above) flagged the structural fix it left out of scope: `HookMiner.computeAddress` ran a
fresh `abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)` on every one of up to
`MAX_ITERATIONS` loop iterations, and Solidity's bump allocator never reclaims that memory
mid-loop, so memory (and its quadratic expansion cost) grows for as long as the search runs. This
task did that fix, first and as its own commit, before writing anything that calls `find` under
broadcast. `find` now lays out the CREATE2 preimage once, in a fixed 85-byte scratch region
allocated a single time per call (`[0xff][deployer(20)][salt(32)][initCodeHash(32)]`, the same
layout OpenZeppelin's `Create2.computeAddress` uses,
`lib/agora-governor/lib/openzeppelin-contracts/contracts/utils/Create2.sol`), and each loop
iteration only overwrites the salt word and rehashes the same 85 bytes.

`contracts/test/unit/HookMiner.t.sol` keeps the old, allocating formula as a private reference
implementation (`_referenceComputeAddress` / `_referenceFind`, not used anywhere outside the
test) and asserts, for two different fixed `(deployer, flags, creationCode, constructorArgs)`
inputs, that the rewritten `find` returns the exact same `(address, salt)` the old formula would
have. A third test mines three times back to back inside one test function body, with no
`this.`-call frame boundary between rounds (the same shape that hit `MemoryOOG` in Task 9), and
all three succeed:

```
Ran 4 tests for test/unit/HookMiner.t.sol:HookMinerTest
[PASS] test_FindsSaltMatchingFlagsAndDeploysThere() (gas: 9132388)
[PASS] test_MatchesReferenceImplementationForFixedInputs() (gas: 11845142)
[PASS] test_MatchesReferenceImplementationForSecondFixedInput() (gas: 4626617)
[PASS] test_MiningThreeTimesInOneFrameDoesNotRunOutOfMemory() (gas: 50629491)
Suite result: ok. 4 passed; 0 failed; 0 skipped; finished in 88.53ms (124.58ms CPU time)
```

### Foundry JSON serializer: nesting behaviour

`DeployFleet.s.sol` builds the manifest's `addresses`, `params`, `compiler`, `pins`, and
`codeHashes` objects with their own `vm.serializeAddress`/`vm.serializeUint`/`vm.serializeString`
calls under a separate object key (e.g. `"addresses"`), then nests the finished sub-object into
the root object with `vm.serializeString(root, "addresses", addrsJson)`, exactly as the task brief
suggested but flagged as unconfirmed (this Foundry version's `serializeString` might write the
value as an escaped string rather than a real nested object). Confirmed directly, with a throwaway
probe script before writing the real one: when the `value` argument to `serializeString` is itself
a valid JSON value (as every `vm.serializeX` call returns), Foundry 1.7.1 nests it as a real JSON
object, not an escaped string. Probe and result:

```solidity
string memory addrs = "addresses";
vm.serializeAddress(addrs, "registry", address(0x1111111111111111111111111111111111111111));
string memory addrsJson = vm.serializeAddress(addrs, "governor", address(0x2222222222222222222222222222222222222222));

string memory root = "manifest";
vm.serializeString(root, "schema", "fleet.manifest.v1");
string memory out = vm.serializeString(root, "addresses", addrsJson);
vm.writeJson(out, "../deployments/_probe.json");
```

```json
{
  "addresses": {
    "governor": "0x2222222222222222222222222222222222222222",
    "registry": "0x1111111111111111111111111111111111111111"
  },
  "schema": "fleet.manifest.v1"
}
```

`jq -r '.addresses.governor' deployments/_probe.json` printed a bare address, not a quoted,
escaped JSON string, confirming real nesting. No `vm.serializeJson`-style rework was needed; the
manifest actually written by the Anvil run (below) confirms the same behaviour for all five nested
objects (`addresses`, `params`, `compiler`, `pins`, `codeHashes`): `jq '.addresses | type'` and the
same for every other nested key print `"object"`, never `"string"`.

### Broadcast observations under `vm.startBroadcast`

Running `DeployFleet.s.sol` against a local Anvil with `--broadcast` produced 12 transactions, all
`status = 0x1` (success), not the 9 the brief's prose estimated:

```
CREATE  FleetRegistry
CREATE  FleetVotes
CREATE  TimelockController
CREATE  TaskLedger
CREATE2 FleetHook
CREATE  AgoraGovernor
CALL    FleetHook.initialize(address)
CALL    TimelockController.grantRole(bytes32,address)   [x4: PROPOSER, EXECUTOR, CANCELLER to governor; CANCELLER to guardian]
CALL    TimelockController.renounceRole(bytes32,address)
```

That is 6 `CREATE`/`CREATE2` entries plus 6 `CALL` entries (`initialize`, four separate
`grantRole` calls, one `renounceRole`) for 12 total; `FleetDeployer.deploy` (unmodified by this
task) issues the four role grants as four separate calls, not one collapsed multicall, so each
gets its own broadcast entry and its own nonce. The brief's own itemised list (registry, token,
timelock, ledger, hook, governor, initialize, "four role calls collapsed as you see them",
renounce) already implicitly allows for this by hedging on the role-call count; the number that
actually matters for the controller note's concern is confirmed below.

**The governor's inline-assembly `create` is broadcast as a real deployment transaction,
matching its predicted post-conditions.** This was the specific risk the controller notes (section
1) flagged as a stop-and-report condition. It is not a problem here: transaction 6 in
`broadcast/DeployFleet.s.sol/31337/run-latest.json` has `"transactionType": "CREATE"`,
`"contractName": "AgoraGovernor"`, and its receipt carries `"status": "0x1"` and a
`contractAddress` equal to the `governor` address in both the script's return value and the
written manifest (`0x5FC8d32690cc91D4c39d9d3abcBD16989F875707`). `cast code` against that address
returns 23,005 bytes of runtime code (matches the compiled `AgoraGovernor` size recorded under
Task 5, above), so the governor is a real, broadcast, on-chain deployment, not something the
script only simulated.

**The hook's CREATE2 lands at the address `HookMiner` predicted.** `FleetDeployer.deploy` reverts
with `HookAddressMismatch` if the deployed hook address does not match `HookMiner.find`'s
prediction (see `contracts/src/deploy/FleetDeployer.sol`); the deploy transaction succeeded, so
the predicted and actual addresses were equal under broadcast. `p.create2Deployer = CREATE2_FACTORY`
(forge-std's `0x4e59b44847b379578588920cA78FbF26c0B4956C`, pre-deployed on Anvil) makes
`HookMiner` search for a salt using the same deployer address Foundry's own `new X{salt: ...}`
CREATE2 routing uses under `vm.startBroadcast`, so the two computations agree. The deployed hook
address is `0xA8d43557A9D305D0B2F98BfEbe07dC0A8DB522c0`, whose low 16 bits (`0x22C0`) match
`FleetHook.PERMISSION_MASK` exactly, and `broadcast/.../run-latest.json` records this transaction
with `"transactionType": "CREATE2"`.

### Deterministic local addresses

Ran twice, on two independently started, fresh Anvil instances (`anvil --block-time 2 --port 8599
--silent`), with the same deployer key (Anvil default account 0) and the same
`deployments/configs/local-5.json`. Both runs produced manifests differing only in
`deploymentBlock` and `deploymentTimestamp`, which record when the run happened; every address,
code hash, and the mined `hookSalt` were identical (`diff` of the two `deployments/31337/latest.json`
outputs showed those two lines and nothing else). This is expected: every
address below is either a `CREATE` address (a pure function of the deployer address and its nonce
at that point) or the `CREATE2` hook address (a pure function of the factory address, the mined
salt, and the init code hash), and both are fully determined by replaying the same sequence from
the same deployer on a fresh chain.

Deployer: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (Anvil default account 0). Nonce sequence
(one nonce per broadcast transaction, in order): `FleetRegistry`=0, `FleetVotes`=1,
`TimelockController`=2, `TaskLedger`=3, the `CALL` to `CREATE2_FACTORY` that deploys `FleetHook`=4,
`AgoraGovernor`=5, `initialize`=6, the four `grantRole` calls=7-10, `renounceRole`=11; the
deployer's nonce was 12 (0-indexed, so 12 transactions sent) immediately after the run, confirmed
with `cast nonce 0xf39Fd6...92266 --rpc-url http://127.0.0.1:8599`.

| Contract       | Address                                      |
| -------------- | --------------------------------------------- |
| FleetRegistry  | `0x5FbDB2315678afecb367f032d93F642f64180aa3`  |
| FleetVotes     | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`  |
| TimelockController | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| TaskLedger     | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9`  |
| FleetHook      | `0xA8d43557A9D305D0B2F98BfEbe07dC0A8DB522c0`  |
| AgoraGovernor  | `0x5FC8d32690cc91D4c39d9d3abcBD16989F875707`  |

`hookSalt` (the CREATE2 salt `HookMiner.find` mined for this exact deployer, config, and
`FleetHook` init code): `0x000000000000000000000000000000000000000000000000000000000003a07f`.

The hook address and salt above are from the final-review re-run. Two things moved `FleetHook`'s
bytecode in that round: the `afterPropose` fix, and `forge fmt` over the whole project, because
reformatting changes the source text and therefore the CBOR metadata hash the compiler appends to
the deployed code. The salt is mined against the hook's init code hash, so
any change to the hook's code or constructor arguments moves both, and the governor's `codehash`
moves with them because the hook address is one of the governor's immutables. Nothing else in the
manifest changed: the five `CREATE` addresses are fixed by the deployer and its nonces.

### Governor bytecode hash outcome

The manifest's `codeHashes.governor` is `address.codehash` (`EXTCODEHASH`) read from the live
chain right after deployment, not a hash of the compiled artifact. For this run it is
`0xfafb3c0159dcdc534750b417df76d953e00bc97cfb4d550ef4685835cc461515`, and re-hashing the deployed
code directly reproduces it exactly:

```
$ cast keccak $(cast code 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 --rpc-url http://127.0.0.1:8599)
0xfafb3c0159dcdc534750b417df76d953e00bc97cfb4d550ef4685835cc461515
```

That hash does **not** equal `keccak256` of `deployedBytecode.object` in the compiled
`contracts/out/AgoraGovernor.sol/AgoraGovernor.json` artifact
(`0x5d653f4f76407df696654ad7b673880c748d86e81035a5da016a89823c731507`), which the controller notes
predicted as a possible outcome because of immutables. Diffing the compiled template against the
live `cast code` output byte-for-byte confirms exactly that: every differing byte range falls
inside an immutable's slot, and every other byte is identical. The differing ranges are, in order
of first appearance: the `hooks` address (`AgoraGovernor.sol`'s own `IHooks public immutable
hooks`, 14 occurrences, since PUSH20 of the same constant appears once per place the compiler
inlined a read of it), the `token` address (`GovernorVotes`'s `IERC5805 private immutable _token`,
5 occurrences), one occurrence of the governor's own address (`EIP712`'s `address private
immutable _cachedThis`, used to detect being called through a proxy/fork), a `ShortString`-encoded
`"AgoraGovernor"` name plus a length byte (`EIP712`'s `ShortString private immutable _name` /
`_version`, via `contracts/lib/.../openzeppelin-contracts/contracts/utils/ShortStrings.sol`), and
three 32-byte words (`EIP712`'s `_cachedDomainSeparator`, and two more inlined hashes for the
name/version). Every one of these is a documented OpenZeppelin `immutable`, confirmed by `grep
immutable` against `GovernorVotes.sol` and `EIP712.sol` in the vendored submodule. Immutables are
substituted into the runtime code at construction time by the Solidity compiler's own codegen
(zero-filled placeholders in the artifact's `deployedBytecode.object`, real values in what actually
gets deployed), so this is expected, not a bug: `codeHashes.governor` correctly captures the code
as deployed, and it necessarily differs from the hash of the pre-deployment template whenever the
contract has immutables, which `AgoraGovernor` (by way of itself and its base contracts) does.

Separately, and this is the check that matters for "is this the pinned upstream code": built
`contracts/lib/agora-governor` standalone (`cd contracts/lib/agora-governor && forge build`, same
pinned commit `11a11641ce1f4f691c300d530eae3c7203593b85`, same `foundry.toml` compiler settings as
our own project: `solc 0.8.29`, `optimizer_runs 200`, `evm_version cancun`) and compared its own
`out/AgoraGovernor.sol/AgoraGovernor.json` `deployedBytecode.object` (and `bytecode.object`)
against ours. The raw bytes differ (our copy is compiled through this project's remapping, from a
different working directory, so the two runs embed different paths in their trailing CBOR metadata),
but stripping each artifact's standard 2-byte-length-prefixed CBOR metadata trailer from the end of
both the creation and runtime bytecode makes them byte-for-byte identical (22,952 bytes of runtime
code each, matching exactly). The code this repository builds and deploys for `AgoraGovernor` is,
modulo compile-path metadata and immutable substitution, exactly the pinned upstream commit's code.

## Final review: hooks calling back into the governor (`noSelfCall`)

Every dispatcher in `contracts/lib/agora-governor/src/libraries/Hooks.sol` carries the same
modifier (line 178):

```solidity
modifier noSelfCall(IHooks self) {
    if (msg.sender != address(self)) {
        _;
    }
}
```

When the governor's `msg.sender` is the hook itself, the hook call is skipped silently. The
governor then falls back to its own logic and returns a normal-looking answer. There is no revert,
no event, and no flag saying an answer was produced without the hook.

This matters most for `beforeVoteSucceeded`. `AgoraGovernor._voteSucceeded`
(`lib/agora-governor/src/AgoraGovernor.sol:481`) is:

```solidity
(bool hasUpdated, uint8 beforeVoteSucceeded) = hooks.beforeVoteSucceeded(proposalId);
if (!hasUpdated) {
    voteSucceeded = super._voteSucceeded(proposalId);
} else {
    voteSucceeded = beforeVoteSucceeded == 2;
}
```

With the hook as caller, `hasUpdated` comes back false and the governor answers with
OpenZeppelin's stock `GovernorCountingSimple` rule (For above Against) combined with Agora's own
`_quorumReached` override (For plus Against plus Abstain against the quorum bar). That is exactly
the counting rule `FleetHook` exists to replace. So `governor.state(proposalId)`, asked by the
hook, can differ from `governor.state(proposalId)` asked by anybody else: a tally of 2 For plus 1
Abstain on a five-member fleet reads **Succeeded** to the hook and **Defeated** to everyone else.

`FleetHook.afterPropose` asks that question, to decide whether a member's previous proposal on the
task has settled. Trusting the stock answer meant every fleet-Defeated proposal looked unsettled
forever, and the member was locked out of proposing on that task for the rest of its life, with no
way back (nothing can cancel a Defeated proposal, and it can never be queued or executed).

The fix is in `FleetHook._isUnsettled` (`contracts/src/FleetHook.sol:286`): it reads
`governor.state(previous)` itself, and when the answer is `Succeeded` it re-applies the fleet rule
from `proposalVotes` and `quorum` rather than believing it. `Pending`, `Active`, and `Queued` are
unaffected, because the fleet rule can only be stricter than the stock rule: a tally that passes
the fleet rule always passes the stock rule too, so a proposal that reached `Queued` really did
pass. `quorum(proposalId)` is safe to call from the hook for the same structural reason in reverse:
`FleetHook` does not request the `beforeQuorumCalculation` bit, so the skipped call and the
made-but-unpermissioned call both return 0 and both fall through to the stock quorum calculation.

`AdmissionTest.test_FleetDefeatedProposalReleasesTheProposerSlot`
(`contracts/test/integration/Admission.t.sol`) asserts both readings of the same proposal in the
same test, `vm.prank(address(hook))` for the hook's view, and is the regression test for this.

**General rule for this codebase: a hook must not use the governor as an oracle for anything the
hook itself overrides.** Any future hook that calls back into `AgoraGovernor` has to re-apply its
own rules to whatever comes back, or read the raw inputs (`proposalVotes`, `proposalSnapshot`,
`proposalDeadline`) and decide for itself.

## Final review: `afterInvariant` runs once before the campaign, with nothing done yet

Foundry 1.7.1 calls a test contract's `afterInvariant()` after each run of an invariant campaign
**and once more before the first run**, with the handler in its post-`setUp` state. Confirmed by
having `afterInvariant` append its counters to a file (file writes survive the state resets between
runs) during a 64-run campaign: the file held 66 records, the first of them all zeroes and the last
one duplicated.

That makes the obvious use of `afterInvariant`, asserting that the campaign actually exercised
something, fail on every campaign unless it is guarded. `TaskLedgerInvariant.afterInvariant`
(`contracts/test/invariant/TaskLedgerInvariant.t.sol`) guards on a `totalCalls` counter the handler
bumps on every entry point, and returns early when it is zero.

Two more things to know before writing such an assertion. It is a **per-run** assertion, not a
per-campaign one: handler storage is reset between runs (a 64-run, depth-32 campaign reports 2,048
handler calls in total but `afterInvariant` sees 32), so whatever it asserts has to be reachable
inside a single run, which is why these invariants raise `depth` to 64 with an inline
`/// forge-config: default.invariant.depth = 64`. And when it does fail, the shrinker reduces the
sequence to a single call and reports that, because a one-call sequence also fails the assertion;
the reported counterexample is therefore not the sequence that actually broke anything.

## Final review: two smaller notes

**A Queued but unexecutable proposal holds its proposer's slot until someone cancels it.** If a
task is completed or stopped while one of its proposals sits queued in the timelock, the proposal
stays `Queued` (the timelock operation is still pending) and execution reverts inside the ledger,
so the proposer's one-proposal-per-task slot never frees on its own. Two parties can clear it, and
the keeper is neither of them: the proposing member calls
`governor.cancel(targets, values, calldatas, descriptionHash)`, or the guardian calls
`timelock.cancel(operationId)`. Both drive `state()` to `Canceled` and release the slot.
`AgoraGovernor.cancel` (`lib/agora-governor/src/AgoraGovernor.sol:244`) admits only the proposer,
`admin`, `_executor()` (the timelock), and `manager`, and this deployment sets `admin` and
`manager` to the zero address, so a keeper key calling `governor.cancel` reverts
`GovernorUnauthorizedCancel` (asserted in
`GuardianTest.test_GuardianCannotCancelAtGovernorOrPropose`). The keeper's role here is to detect
the stuck proposal and prompt the member or the guardian, not to cancel it itself.

**The hook's CREATE2 through the public factory is front-runnable, for denial of service only.**
`DeployFleet.s.sol` sends `FleetHook`'s CREATE2 through the canonical public factory at
`0x4e59b44847b379578588920cA78FbF26c0B4956C`, so anyone watching the mempool can submit the same
salt and init code first; the resulting contract is byte-identical with identical constructor
arguments, so the only consequence is that the deployer's own transaction reverts and the run has
to be restarted (the deployment sequence checks `address(hook) != predictedHook` and reverts
`FleetDeployer.HookAddressMismatch` rather than continuing against a stranger's contract).
