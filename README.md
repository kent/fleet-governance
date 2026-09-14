# Fleet Governance

A fleet of agents works a shared task and votes onchain when it diverges. See `docs/spec.md` for the full product and technical specification.

## Layout

- `contracts/`: Foundry project with FleetRegistry, FleetVotes, FleetHook, TaskLedger, the pinned Agora Governor and TimelockController, plus deploy scripts and tests.
- `packages/`: TypeScript packages shared across the workspace, starting with `packages/abi`, which exports the contract ABIs as typed `const` arrays for viem.
- `apps/`: TypeScript applications (SDK consumers, runner, and related services), added as later tasks land.
- `deployments/`: Deployment manifests and configs, per chain id.
- `infra/`: Local stack configuration (Anvil, DAO Node, CPLS, Postgres, Agora Next), added as later tasks land.
- `docs/`: Specification and supporting notes.

## Workspace

This is a pnpm workspace. Node 22, pnpm, and TypeScript in strict ESM mode across packages.

- `pnpm install` installs all workspace dependencies.
- `pnpm build` builds every package.
- `pnpm test` runs unit tests; `pnpm test:integration` runs integration tests.
- `pnpm typecheck` runs the TypeScript project build.
