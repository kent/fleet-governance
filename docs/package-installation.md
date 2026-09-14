# Package installation behind the gate

An approved registry does not make every URL in its package metadata approved. The installer
checks each metadata and tarball request before it downloads anything. If one request is blocked,
the install stops and the candidate dependency volume is removed.

Runner supplies `DockerPackageInstaller` to each agent's `ToolRouter`. A model still uses the
ordinary tool:

```json
{
  "class": "package_install",
  "target": "registry.npmjs.org",
  "args": { "pkg": "some-package@1.0.0" }
}
```

The constitution must permit the outer `package_install` operation and its `network_fetch`
downloads, or the fleet must settle the relevant exception or amendment. Allowing one class
does not silently allow the other.

## Where execution stops

1. The gateway checks the requested install against current ledger state.
2. A container starts with no external network, an unprivileged user, a read-only root filesystem
   and no host workspace or credentials mounted. It gets a clean project and npm configuration.
3. A small registry adapter listens on loopback inside that container. It requests upstream
   downloads over framed stdin and stdout. Package tarball URLs become opaque local tokens;
   the broker retains responsibility for checking the original destination.
4. Before every upstream request, the host broker reads a fresh ledger snapshot. It checks the
   exact HTTPS hostname, path and query as a `network_fetch` action, counts it against the tool
   budget and records the verdict. It permits GET only, with no delegated credentials or headers.
5. A blocked download terminates the installer. The task loop shows the model that exact download
   and lets it propose, drop or escalate. An unrelated approval does not release the original
   install. A retry still passes through the gateway and checks every download again.
6. A successful install replaces the agent's dependency volume. Tests receive only its
   `node_modules` directory, mounted read-only. Failed installs leave prior dependencies intact.
   When the model run ends, Runner removes the retained volume.

Docker's `none` network creates only a loopback interface. The registry adapter uses that local
interface; npm has no direct external route. The test sandbox uses Docker's `volume-subpath`
mount to expose only the installed dependencies. The integration run used Docker 29.2.1.
[Docker network isolation](https://docs.docker.com/engine/network/drivers/none/),
[Docker volume subdirectories](https://docs.docker.com/engine/storage/volumes/#mount-a-volume-subdirectory).

Installation passes `--ignore-scripts`. Package lifecycle scripts do not run during installation.
The later `run_tests` tool intentionally runs the project's test command inside its separate
sandbox. Importing a dependency there executes its code under that sandbox's restrictions.
[npm script configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#ignore-scripts).

## Supported work and limits

Registry packages, versions and transitive registry dependencies are supported. The initial
package argument is validated and passed as an argument, never through a shell. The installer
rebuilds the requested root packages on each successful change. Version ranges can resolve
differently on a later install; this is not a reproducible lockfile workflow.

Direct URL, git and local path dependencies are unsupported. A required direct URL dependency
cannot use npm to bypass the broker. Redirects are refused, including redirects to an otherwise
allowed host. Private registry authentication and registry changes within an existing workspace
are unsupported. Packages that require installation scripts may install incompletely or fail.

Each download is limited to 16 MiB and 15 seconds. One install permits at most 256 broker requests
and 64 MiB downloaded, with a two-minute installer deadline. The container has a 512 MiB memory
limit, one CPU, a 128-process limit and 256 MiB of temporary scratch space. Captured output is
bounded. The named dependency volume has no hard disk quota; production workers need one.

Cancellation and timeout remove the actual named container before removing its candidate volume.
The installer avoids Docker's automatic removal so cleanup has one owner. A cleanup failure fails
the tool call. Resources carry a `fleet-installer-owner` label for inspection. A crashed host or
unreachable Docker daemon still needs operator recovery; there is no demonstrated crash janitor.

This is an offchain boundary. A ledger check and an HTTP dispatch are not atomic. A permission
revoked after a request starts cannot recall its bytes. Every subsequent request checks again.
The exact URL exception follows the gateway's existing task and constitution-version rules;
it is reusable until invalidated. It is not the contract executor's single-use artifact permit.

The host broker, Docker daemon, installed image and kernel remain trusted. A permitted URL can
still expose a vulnerable service. The sample does not prove resistance to the Hugging Face
exploit chain, DNS rebinding, a container escape or a compromised broker. Production deployment
needs independent host and egress controls around those components.

## Reproduce the enforcement checks

```sh
docker pull node:22-alpine
pnpm typecheck
pnpm --filter @fleet/agent-runtime build
FLEET_INTEGRATION=1 pnpm exec vitest run --project integration \
  packages/agent-runtime/src/sandbox/package-installer.integration.test.ts
```

The eight Docker tests install locally generated tarballs through the real broker. They cover
ordinary imports, transitive dependencies, disabled lifecycle scripts, ignored workspace npm
configuration, read-only test mounts, a blocked external tarball followed by its exact grant,
a pause between metadata and tarball requests, rejected redirects, a direct egress canary,
cancellation, timeout and resource cleanup. Ledger state and upstream HTTP responses are test
doubles here. These tests do not claim an onchain vote or a live registry observation.

The broker unit tests also cover expired constitution-version exceptions, changed queries,
escalation, budgets, invalid URLs, response size limits and stalled stream cancellation.
Task-loop tests confirm that only the matching recorded grant permits an install retry.

Source: [installer](../packages/agent-runtime/src/sandbox/package-installer.ts),
[container adapter](../packages/agent-runtime/src/sandbox/installer-client.mjs),
[download broker](../packages/agent-runtime/src/sandbox/package-broker.ts),
[integration tests](../packages/agent-runtime/src/sandbox/package-installer.integration.test.ts).
