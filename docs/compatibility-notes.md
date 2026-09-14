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
