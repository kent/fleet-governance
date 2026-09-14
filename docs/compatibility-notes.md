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

`[lint] ignore = ["lib/**"]` does not work around this: it only excludes matched files from
having lint *rules* reported, but `solar` still tries to resolve their imports while building
its analysis graph and still fails with the same "file not found" error.

**Fix applied:** added to `contracts/foundry.toml`:

```toml
[lint]
lint_on_build = false
```

This is one section beyond the brief's verbatim `foundry.toml` content, added because
without it `forge build` (the project's most basic command, used by every later task) always
fails on this vendored submodule regardless of remapping choice. With `lint_on_build = false`,
`forge build` and `forge build --sizes` compile cleanly with exit code 0 and no error output.

**Known residual noise:** `forge test` still prints the same non-fatal `solar` "file not
found" lines to stderr on every run (this does not appear to be gated by
`lint_on_build`), but it does not affect the exit code or test results; `forge test` exits 0
and all tests pass. This looks like a `forge test` behavior that runs its own lint pass
regardless of the `lint_on_build` setting used by `forge build`. Treat these lines as benign
tool noise from `solar`, not a real compilation or test failure, unless a later Foundry
release changes this behavior.
