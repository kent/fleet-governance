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
