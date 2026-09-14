# Fleet Governance v1 Implementation Plan (overview)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build v1 of Fleet Governance on Base: a fleet of agents working a shared task under a charter, voting through an unmodified Agora Governor when they diverge, with every proposal, vote, reason, and decision public on Base and rendered in Agora Next, all runnable locally and orchestrated by an Experiment Runner.

**Architecture:** Four Solidity contracts of ours (`FleetRegistry`, `FleetVotes`, `FleetHook`, `TaskLedger`) around the pinned Agora Governor and OpenZeppelin timelock, deployed by a deterministic Foundry script. A TypeScript monorepo provides the SDK, charter gateway, agent runtime, keeper, and Runner. Agora's DAO Node and CPLS index the chain into an archive that a forked Agora Next renders through a `fleet` tenant.

**Tech Stack:** Solidity 0.8.29 + Foundry 1.7.1; TypeScript + viem + Node 22 + pnpm; Next.js (Runner UI, Agora Next fork); Python 3.11 (DAO Node, CPLS, vendored); PostgreSQL 16; Docker Compose; Anvil; Base Sepolia.

**Spec:** `docs/spec.md` (v0.2, September 13, 2026). Read it first. Section numbers below refer to it.

## Global Constraints

- Agora Governor pinned at `voteagora/agora-governor@11a11641ce1f4f691c300d530eae3c7203593b85`; its OpenZeppelin fork at `3d139e998b9843179d72b28a3264834b01baf160`. Compile with solc `0.8.29`, EVM `cancun`, optimizer runs `200`, so the governor bytecode matches upstream. (Spec 5.1, 5.2)
- The governor is deployed unmodified. Every fleet rule lives in `FleetHook`, permission mask `0x22C0` (beforeVoteSucceeded, beforeVote, beforePropose, afterPropose). (Spec 7.4)
- No onchain factory. Deployment is `contracts/script/DeployFleet.s.sol` driven by a JSON config; the hook is deployed with CREATE2 at a mined salt through `0x4e59b44847b379578588920cA78FbF26c0B4956C`. (Spec 7.1)
- One token per member, `1e18`, non-transferable, delegatable only to registry members, timestamp clock. (Spec 7.3)
- Success rule: `For >= quorum(proposalId) && For > Against`, quorum numerator `6000` of `10000`. (Spec 6, 7.4)
- Onchain string bounds: charter 1 to 8,192 bytes; description 1 to 4,096 bytes; vote reason 1 to 1,024 bytes; summary at most 1,024 bytes; fleet manifest at most 4,096; agent manifest at most 2,048. (Spec 6, 7.2, 7.6)
- Every proposal description ends with the line `#proposalTypeId=0` (DAO Node compatibility). (Spec 8.2)
- Enforcement in v1 is the offchain gateway; contracts record. Say so in code comments and UI copy wherever it matters. (Spec 1.3, 10.2)
- Chains: Anvil `31337` (block time 2 s), Base Sepolia `84532`. Mainnet `8453` is refused by every tool in v1. (Spec 6, 12.1)
- Pinned Agora services: DAO Node `cb299a07a917dce80b12699d5bf96695cf1120b6`, CPLS `be1ef85645b467008fb6028d6df9db4e6f39dc66`, Agora Next `a9909c796ccb3d6fafb63a199d82c9d4af9ee48d`. (Spec 5.1)
- No em dashes anywhere in user-facing copy, docs, or UI strings. Split the sentence instead.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: [private session removed]
  ```
- Never document a command as working until it has been run and its output checked.

## Parts and order

| Part | Plan file | Produces | Depends on |
| --- | --- | --- | --- |
| 1 | `2026-09-14-fleet-governance-v1-part1-contracts.md` | Contracts, tests, deploy and verify scripts, ABI export, local Anvil deployment | nothing |
| 2 | `2026-09-14-fleet-governance-v1-part2-agora-stack.md` | Docker Compose stack: Anvil, Postgres stub, DAO Node (patched), CPLS, archive store, Agora Next `fleet` tenant | Part 1 ABIs and a deployment |
| 3 | `2026-09-14-fleet-governance-v1-part3-sdk-runtime.md` | `packages/schemas`, `packages/abi`, `packages/sdk`, `packages/gateway`, scripted agents, keeper, Runner CLI (headless pipeline) | Part 1 |
| 4 | `2026-09-14-fleet-governance-v1-part4-runner-agents.md` | Runner UI (config panel, run view, reports), sandboxed task executor, model provider adapters, Hugging Face replay fixture | Parts 2 and 3 |

Parts 2 and 3 are independent of each other and can run in parallel after Part 1. Part 4 needs both.

## Milestone mapping (spec section 14)

- M0 (dependency chain and local Agora stack) = Part 1 Task 1 plus Part 2 through its acceptance task.
- M1 (contracts) = Part 1.
- M2 (SDK, gateway, scripted agents, keeper, Runner CLI) = Part 3.
- M3 (Runner UI, model agents, sandbox) = Part 4.
- M4 (Base Sepolia pilot) needs credentials the owner supplies: an RPC provider with HTTP and WebSocket endpoints, a GCS bucket and service account, and funded test keys. It is listed at the end of Part 4 as a runbook, not automated here.

## Repository conventions

- Monorepo root is this directory. `pnpm` workspaces for TypeScript packages (`packages/*`, `apps/*`). Foundry project in `contracts/`. Vendored forks as git submodules in `vendor/`. Infra in `infra/`.
- TypeScript: strict mode, ESM, Node 22, `vitest` for tests, `tsx` for scripts. Solidity integers are `bigint` end to end; never `number`.
- Every package has a `README.md` stating what it does, how to run it, and what it depends on.
- `docs/compatibility-notes.md` accumulates every upstream quirk and patch discovered while building. Update it in the task that discovers the quirk.
