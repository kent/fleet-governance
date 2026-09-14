# Fleet Governance v1, Part 2: Local Agora Stack

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `docker compose up` brings up Anvil, Postgres, DAO Node (patched), CPLS, an archive store, and an Agora Next `fleet` tenant that renders proposals, votes with reasons, and delegates for a fleet deployed by Part 1's script. This is spec milestone M0's stack half.

**Architecture:** Agora's services are vendored as git submodules at the pinned commits. Our changes are patch files and overlay directories applied at Docker build time, so the upstream trees stay pristine and every change is reviewable in `infra/`. A bootstrap script deploys the fleet with Part 1's Foundry script, writes DAO Node's YAML and address-named ABI files, writes Agora Next's deployment file, starts the read side, and runs one scripted proposal to prove the pipeline end to end.

**Tech Stack:** Docker Compose v5, Python 3.11 images for DAO Node and CPLS, Node 20 image for Agora Next, PostgreSQL 16, `fsouza/fake-gcs-server` for offline archive storage, Anvil from the Foundry image.

**Spec:** `docs/spec.md` sections 5.3, 5.4, 5.5, 11, 14 (M0), 16.1.

## Global Constraints

See the overview plan. Additionally:

- Upstream submodules are never modified in place. Changes live in `infra/<service>/patches/*.patch` (for edits to existing files) and `infra/<service>/overlay/` (for new files), applied by the Dockerfile.
- Every service has a health check and the bootstrap script waits on it. Nothing is declared working until the M0 acceptance task's checks pass with output pasted into `docs/compatibility-notes.md`.
- Default archive store is a real GCS bucket when `GCS_BUCKET_NAME` and `GOOGLE_APPLICATION_CREDENTIALS` are set; otherwise the compose `offline` profile starts fake GCS and points both CPLS and Agora Next at it.
- No mainnet anything. Compose only knows Anvil and, via env, Base Sepolia.

## File structure

```
vendor/
  dao-node/                         submodule @ cb299a07a917dce80b12699d5bf96695cf1120b6
  cpls/                             submodule @ be1ef85645b467008fb6028d6df9db4e6f39dc66
  agora-next/                       submodule @ a9909c796ccb3d6fafb63a199d82c9d4af9ee48d
infra/
  docker-compose.yml
  .env.example
  anvil/Dockerfile                  foundry image, block-time 2, chain-id 31337
  postgres/init/01-roles.sql        roles and databases (agora_web2, agora_web3, runner)
  postgres/init/02-agora-stub.sql   generated: fleet.* tables, agora.* web2 tables, config.DaoSlug enum
  postgres/gen-stub.ts              generates 02-agora-stub.sql from vendor/agora-next/prisma/schema.prisma
  dao-node/Dockerfile
  dao-node/patches/0001-abi-dir-and-env-abi-url.patch
  dao-node/patches/0002-default-proposal-type-when-marker-missing.patch
  dao-node/patches/0003-optional-start-block.patch
  dao-node/config.template.yaml
  dao-node/entrypoint.sh            renders template from env, starts sanic
  cpls/Dockerfile
  cpls/entrypoint.sh
  fake-gcs/                         (no files; image only) 
  agora-next/Dockerfile
  agora-next/patches/0001-fleet-tenant-registration.patch     constants, factories, prismaUtils switches, quorum cases, schema list
  agora-next/overlay/src/lib/tenant/configs/contracts/fleet.ts
  agora-next/overlay/src/lib/tenant/configs/ui/fleet.ts
  agora-next/overlay/src/lib/contracts/abis/AgoraGovernorV2.json
  agora-next/overlay/src/lib/contracts/abis/FleetVotes.json
  agora-next/overlay/prisma/fleet-views.prisma               appended to schema.prisma by the Dockerfile
  agora-next/.env.fleet.example
  scripts/bootstrap-local.sh        deploy + configure + start read side + smoke
  scripts/write-daonode-config.sh   manifest -> yaml + abi dir
  scripts/write-agora-next-deployment.sh  manifest -> deployment json
  scripts/scripted-proposal.sh      cast-based propose/vote/queue/execute for the M0 check
  scripts/wait-for.sh
docs/compatibility-notes.md
```

---

### Task 1: Vendor the three Agora services as pinned submodules

**Files:**
- Modify: `.gitmodules`
- Create: `vendor/README.md`

- [ ] **Step 1: Add submodules**

```bash
cd /home/operator/bliss/agora-ai/fleet-governance
git submodule add https://github.com/voteagora/dao-node.git vendor/dao-node
git -C vendor/dao-node checkout cb299a07a917dce80b12699d5bf96695cf1120b6
git submodule add https://github.com/voteagora/cpls.git vendor/cpls
git -C vendor/cpls checkout be1ef85645b467008fb6028d6df9db4e6f39dc66
git submodule add https://github.com/voteagora/agora-next.git vendor/agora-next
git -C vendor/agora-next checkout a9909c796ccb3d6fafb63a199d82c9d4af9ee48d
git submodule status
```
Expected: three lines with the exact commits.

- [ ] **Step 2: vendor/README.md**

State the pins, that patches live in `infra/`, and the command to re-pin (`git -C vendor/<x> fetch && git -C vendor/<x> checkout <commit>` followed by re-running Part 2 acceptance).

- [ ] **Step 3: Commit**

```bash
git add .gitmodules vendor
git commit -m "chore(vendor): pin dao-node, cpls, agora-next submodules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 2: Anvil and Postgres services with the Agora stub schema

**Files:**
- Create: `infra/docker-compose.yml` (anvil, postgres only at this point), `infra/anvil/Dockerfile`, `infra/postgres/init/01-roles.sql`, `infra/postgres/gen-stub.ts`, `infra/postgres/init/02-agora-stub.sql` (generated and committed), `infra/.env.example`
- Test: `infra/postgres/gen-stub.test.ts` (vitest, run with `npx tsx --test` style or the root vitest once Part 3 exists; until then run `node --test` on a compiled file or `npx vitest run infra/postgres`)

**Interfaces:**
- Produces: databases `agora_web2`, `agora_web3`, `runner` on `postgres:5432` with user `agora`/`agora`. `agora_web3` contains schemas `fleet`, `agora`, `config`; `agora_web2` contains the web2 tables Agora Next writes to.

- [ ] **Step 1: Anvil image**

`infra/anvil/Dockerfile`:
```dockerfile
FROM ghcr.io/foundry-rs/foundry:v1.7.1
EXPOSE 8545
ENTRYPOINT ["anvil", "--host", "0.0.0.0", "--port", "8545", "--chain-id", "31337", "--block-time", "2", "--accounts", "10", "--balance", "10000"]
```
If that image tag does not exist, use `ghcr.io/foundry-rs/foundry:latest` and record the digest in compatibility notes.

- [ ] **Step 2: Roles**

`infra/postgres/init/01-roles.sql`:
```sql
CREATE DATABASE agora_web2;
CREATE DATABASE agora_web3;
CREATE DATABASE runner;
```
(The `POSTGRES_USER=agora` from compose owns everything; Prisma needs both URLs.)

- [ ] **Step 3: Write the failing generator test**

`infra/postgres/gen-stub.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { prismaTypeToPg, extractModelsForSchema, renderCreateTable } from "./gen-stub";

describe("gen-stub", () => {
  it("maps prisma scalar types to postgres", () => {
    expect(prismaTypeToPg("String")).toBe("text");
    expect(prismaTypeToPg("Int")).toBe("integer");
    expect(prismaTypeToPg("BigInt")).toBe("bigint");
    expect(prismaTypeToPg("Decimal")).toBe("numeric");
    expect(prismaTypeToPg("Boolean")).toBe("boolean");
    expect(prismaTypeToPg("DateTime")).toBe("timestamp");
    expect(prismaTypeToPg("Json")).toBe("jsonb");
    expect(prismaTypeToPg("Bytes")).toBe("bytea");
  });

  it("extracts views mapped to a schema and renders tables", () => {
    const schema = `
view b3Proposals {
  proposal_id String @id
  proposer    String?
  start_block Decimal? @db.Decimal
  @@map("proposals_v2")
  @@schema("b3")
}
model Other {
  id Int @id
  @@schema("agora")
}
`;
    const models = extractModelsForSchema(schema, "b3");
    expect(models).toHaveLength(1);
    expect(models[0].table).toBe("proposals_v2");
    const sql = renderCreateTable(models[0], "fleet");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "fleet"."proposals_v2"');
    expect(sql).toContain('"proposal_id" text');
    expect(sql).toContain('"start_block" numeric');
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd infra/postgres && npx vitest run` (install vitest and tsx locally in `infra/` with a small `package.json` if the root workspace does not exist yet).
Expected: import failure.

- [ ] **Step 5: Implement the generator**

`infra/postgres/gen-stub.ts`: parse `vendor/agora-next/prisma/schema.prisma` line by line. For each `view`/`model` block, capture fields (`name type modifiers`), `@@map("table")` and `@@schema("x")`. `extractModelsForSchema(text, "b3")` returns `{ name, table, fields: [{ column, pgType, nullable }] }[]` using `@map("col")` on a field when present. `renderCreateTable(model, targetSchema)` emits `CREATE TABLE IF NOT EXISTS "fleet"."<table>" (<cols>)` with no constraints (these are stubs for empty reads). `main()` writes `02-agora-stub.sql` containing: `CREATE SCHEMA IF NOT EXISTS fleet; CREATE SCHEMA IF NOT EXISTS agora; CREATE SCHEMA IF NOT EXISTS config;`, all `b3`-schema views re-rendered into `fleet`, every model with `@@schema("agora")` and `@@schema("config")` rendered as-is (these are shared tables Agora Next reads or writes: delegate statements, api users, etc.), and the `DaoSlug` enum as a Postgres enum type including `FLEET`. Also write the same web2 tables into a second file for `agora_web2` if Agora Next's Prisma splits them; check `src/app/lib/prisma.ts` to see which client reads which schema and record the finding.

- [ ] **Step 6: Generate, run tests, boot**

Run: `npx tsx infra/postgres/gen-stub.ts && npx vitest run infra/postgres` then `docker compose -f infra/docker-compose.yml up -d anvil postgres` and `psql postgres://agora:agora@localhost:5432/agora_web3 -c '\dt fleet.*'`.
Expected: tests pass; the fleet tables exist; `cast chain-id --rpc-url http://localhost:8545` prints 31337 and `cast block-number` grows every 2 seconds.

- [ ] **Step 7: Commit**

```bash
git add infra
git commit -m "feat(infra): anvil and postgres services with generated Agora stub schema

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 3: DAO Node image with the three patches

**Files:**
- Create: `infra/dao-node/Dockerfile`, `infra/dao-node/entrypoint.sh`, `infra/dao-node/config.template.yaml`, three patch files
- Modify: `infra/docker-compose.yml` (add `dao-node`)

**Interfaces:**
- Consumes: a Part 1 manifest at `deployments/31337/latest.json`; ABI files at `infra/dao-node/abis/<lowercase-address>.json` (written by Task 6's script).
- Produces: `http://localhost:8000/v1/...` serving the fleet.

- [ ] **Step 1: Patch 0001, ABI directory and env-honoured ABI URL**

In `app/server.py`, replace the hardcoded `os.environ['ABI_URL'] = 'https://storage.googleapis.com/agora-abis/v2'` with `os.environ.setdefault('ABI_URL', 'https://storage.googleapis.com/agora-abis/v2')`. Add a helper `load_abi(name, address, chain_id)` that, when `ABI_DIR` is set and `<ABI_DIR>/<address>.json` exists, returns `ABI.from_file(name, path)`, else falls back to `ABI.from_internet(...)`. Use it for token, gov, ptc, voting_module. Apply the same `setdefault` in `app/clients_csv.py`. Produce the patch with `git -C vendor/dao-node diff > infra/dao-node/patches/0001-...patch` and then `git -C vendor/dao-node checkout .` so the submodule stays clean.

- [ ] **Step 2: Patch 0002, tolerate a missing proposal type marker**

In `app/data_products.py`, the `agora >= 2.0` branch does `description.split('#proposalTypeId=')[1]...`. Replace with:
```python
description = proposal.create_event.get('description') or ''
marker = '#proposalTypeId='
proposal_type = int(description.split(marker)[1].split('#')[0]) if marker in description else 0
proposal.set_proposal_type(proposal_type)
```

- [ ] **Step 3: Patch 0003, optional start block**

In `app/clients_httpjson.py` `JsonRpcHistHttpClient.get_fallback_block`, before the seven-day search, honour `DAO_NODE_START_BLOCK` env (integer) when set: return it. Document in the patch header that the Runner sets it from the manifest's `deploymentBlock`.

- [ ] **Step 4: Dockerfile and entrypoint**

`infra/dao-node/Dockerfile`:
```dockerfile
FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git patch && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY vendor/dao-node /app
COPY infra/dao-node/patches /patches
RUN for p in /patches/*.patch; do patch -p1 < "$p"; done
RUN pip install --no-cache-dir -r requirements.txt
COPY infra/dao-node/config.template.yaml /config.template.yaml
COPY infra/dao-node/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8000
ENTRYPOINT ["/entrypoint.sh"]
```
Build context is the repo root (`context: ..` in compose).

`config.template.yaml` (rendered with `envsubst`):
```yaml
friendly_short_name: Fleet
dao_slug: FLEET
schema: fleet
wrapped_tenant_prefix: fleet
index_tenant_prefix: fleet
token_spec:
  name: erc20
  version: '?'
governor_spec:
  name: agora
  version: 2.0
features:
  staking: False
deployments:
  ${CONTRACT_DEPLOYMENT}:
    chain_id: ${CHAIN_ID}
    token:
      address: '${TOKEN_ADDRESS}'
      decimals: 18
    gov:
      address: '${GOVERNOR_ADDRESS}'
```
`entrypoint.sh`: `envsubst < /config.template.yaml > /config.yaml; export AGORA_CONFIG_FILE=/config.yaml; exec sanic app.server --host=0.0.0.0 --port=8000`. Env in compose: `CONTRACT_DEPLOYMENT=local`, `CHAIN_ID=31337`, `TOKEN_ADDRESS`, `GOVERNOR_ADDRESS` (from `infra/.env`, written by Task 6), `DAO_NODE_ARCHIVE_NODE_HTTP=http://anvil:8545`, `DAO_NODE_REALTIME_NODE_WS=ws://anvil:8545`, `ABI_DIR=/abis`, `DAO_NODE_START_BLOCK`, volume `../infra/dao-node/abis:/abis:ro`. Health check: `curl -sf http://localhost:8000/v1/progress` (fall back to `/health` if `/v1/progress` is not routed at this commit; the routes list showed `/v1/progress`).

- [ ] **Step 5: Boot against a deployed fleet**

Deploy with Part 1's script first (Task 6's script automates this; for now run it by hand), write the two env values and the ABI files by hand once, then `docker compose up -d --build dao-node` and:
```bash
curl -s localhost:8000/v1/progress | jq .
curl -s localhost:8000/v1/delegates | jq '.delegates | length'      # expect 5
curl -s "localhost:8000/v1/balance/<member>" | jq .
```
Expected: progress at tip, five delegates with `1e18` voting power. Record exact response shapes in compatibility notes; Part 3's SDK does not consume them, but the Runner's health page does.

- [ ] **Step 6: Commit**

```bash
git add infra/dao-node infra/docker-compose.yml
git commit -m "feat(infra): DAO Node image with ABI dir, marker tolerance, start block patches

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 4: CPLS and the archive store

**Files:**
- Create: `infra/cpls/Dockerfile`, `infra/cpls/entrypoint.sh`
- Modify: `infra/docker-compose.yml` (add `cpls`, and `fake-gcs` under profile `offline`)

- [ ] **Step 1: Dockerfile**

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY vendor/cpls /app
RUN pip install --no-cache-dir -r requirements.txt
COPY infra/cpls/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8001
ENTRYPOINT ["/entrypoint.sh"]
```
`entrypoint.sh` runs `uvicorn cpls.server:app --host 0.0.0.0 --port 8001` (confirm the module path from `vendor/cpls/Dockerfile`; copy its CMD).

- [ ] **Step 2: Compose wiring**

`cpls` env: `ENVIRONMENT=dev`, `GCS_BUCKET_NAME=${GCS_BUCKET_NAME:-fleet-archive-dev}`, `DAO_NODE_URL_TEMPLATE=http://dao-node:8000`, `SCHEDULER_INTERVAL_MINUTES=1`, `GOOGLE_APPLICATION_CREDENTIALS=/secrets/gcs.json` with an optional bind mount of `${GCS_CREDENTIALS_FILE}`; when the `offline` profile is active, also `STORAGE_EMULATOR_HOST=http://fake-gcs:4443`. Check `vendor/cpls/cpls/config.py` and `sync_daonode.py` for the exact env names (`DAO_NODE_URL_TEMPLATE` is imported from config; confirm its env key) and the tenant list it iterates (it may read a tenants file or env; add `fleet` there). Record findings.

`fake-gcs` service: image `fsouza/fake-gcs-server`, command `-scheme http -port 4443 -public-host localhost:4443 -external-url http://localhost:4443`, with an init step that creates bucket `fleet-archive-dev` (`curl -X POST http://localhost:4443/storage/v1/b?project=fleet -d '{"name":"fleet-archive-dev"}'`) in `scripts/bootstrap-local.sh`.

- [ ] **Step 3: Verify a job writes the archive**

```bash
curl -s -X POST localhost:8001/jobs -H 'content-type: application/json' -d '{"type":"sync_daonode","payload":{"tenant":"fleet"}}'
sleep 5
curl -s "http://localhost:4443/storage/v1/b/fleet-archive-dev/o" | jq '.items[].name'
```
Expected: `data/fleet/proposal_list/dao_node/raw.ndjson.gz` (empty list before any proposal) plus related objects. Exact job type and payload come from `cpls/jobs.py`; record them.

- [ ] **Step 4: Commit**

```bash
git add infra/cpls infra/docker-compose.yml
git commit -m "feat(infra): CPLS service and offline fake GCS archive store

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 5: Agora Next fleet tenant

**Files:**
- Create: `infra/agora-next/Dockerfile`, `infra/agora-next/patches/0001-fleet-tenant-registration.patch`, overlay files listed in the file structure, `infra/agora-next/.env.fleet.example`
- Modify: `infra/docker-compose.yml` (add `agora-next`)

**Interfaces:**
- Consumes: `FLEET_DEPLOYMENT_FILE` JSON `{ "chainId": 31337, "governor": "0x..", "token": "0x..", "timelock": "0x..", "ledger": "0x..", "hook": "0x..", "registry": "0x.." }` written by Task 6.
- Produces: `http://localhost:3000` with pages `/proposals`, `/proposals/<id>`, `/delegates`, `/delegates/<address>` for the fleet tenant.

- [ ] **Step 1: Study the exact edit points**

Open in `vendor/agora-next`: `src/lib/constants.ts` (`TENANT_NAMESPACES`, `GOVERNOR_TYPE`, `DELEGATION_MODEL`), `src/lib/tenant/tenantSlugFactory.ts`, `tenantContractFactory.ts`, `tenantUIFactory.ts`, `tenantTokenFactory.ts`, `tenant.ts` (`BRAND_NAME_MAPPINGS`), `src/lib/prismaUtils.ts` (every `switch (namespace)`), `src/lib/proposals/status/standard.ts` (`calculateQuorumNumber`, `calculateQuorumBigInt`), `src/lib/proposalUtils/proposalStatus.ts` and the helper it calls for `getProposalCurrentQuorum`, `src/lib/tenant/configs/contracts/b3.ts`, `src/lib/tenant/configs/ui/b3.ts`, `prisma/schema.prisma` (`datasource.schemas`, `enum DaoSlug`, the `b3*` views). Write the list of line numbers into compatibility notes before editing.

- [ ] **Step 2: Overlay: contracts config**

`infra/agora-next/overlay/src/lib/tenant/configs/contracts/fleet.ts` modelled on `b3.ts`:
```ts
import { TenantContracts } from "@/lib/types";
import { base, baseSepolia, foundry } from "viem/chains";
import { JsonRpcProvider } from "ethers";
import { readFileSync } from "fs";
import { AgoraGovernor__factory, FleetVotes__factory, AgoraTimelock__factory } from "@/lib/contracts/generated";
import { DELEGATION_MODEL, GOVERNOR_TYPE, TIMELOCK_TYPE } from "@/lib/constants";
import { getRpcUrlForChain } from "@/lib/rpcConfig";

type Deployment = { chainId: number; governor: `0x${string}`; token: `0x${string}`; timelock: `0x${string}`; ledger: `0x${string}`; hook: `0x${string}`; registry: `0x${string}` };

function loadDeployment(): Deployment {
  const file = process.env.FLEET_DEPLOYMENT_FILE;
  if (file) return JSON.parse(readFileSync(file, "utf8")) as Deployment;   // re-read per call in dev
  return {
    chainId: Number(process.env.NEXT_PUBLIC_FLEET_CHAIN_ID ?? 84532),
    governor: process.env.NEXT_PUBLIC_FLEET_GOVERNOR as `0x${string}`,
    token: process.env.NEXT_PUBLIC_FLEET_TOKEN as `0x${string}`,
    timelock: process.env.NEXT_PUBLIC_FLEET_TIMELOCK as `0x${string}`,
    ledger: process.env.NEXT_PUBLIC_FLEET_LEDGER as `0x${string}`,
    hook: process.env.NEXT_PUBLIC_FLEET_HOOK as `0x${string}`,
    registry: process.env.NEXT_PUBLIC_FLEET_REGISTRY as `0x${string}`,
  };
}

export const fleetTenantContractConfig = ({ isProd, rpcSecret }: { isProd: boolean; rpcSecret?: string }): TenantContracts => {
  const d = loadDeployment();
  const chain = d.chainId === 31337 ? { ...foundry, id: 31337 } : isProd ? base : baseSepolia;
  const provider = new JsonRpcProvider(getRpcUrlForChain(chain.id, rpcSecret));
  return {
    token: { address: d.token, abi: FleetVotes__factory.abi, contract: FleetVotes__factory.connect(d.token, provider), chain, provider },
    governor: { address: d.governor, abi: AgoraGovernor__factory.abi, contract: AgoraGovernor__factory.connect(d.governor, provider), chain, provider, optionBudgetChangeDate: undefined },
    timelock: { address: d.timelock, abi: AgoraTimelock__factory.abi, contract: AgoraTimelock__factory.connect(d.timelock, provider), chain, provider },
    governorType: GOVERNOR_TYPE.AGORA,
    timelockType: TIMELOCK_TYPE.TIMELOCK_NO_ACCESS_CONTROL,
    delegationModel: DELEGATION_MODEL.FULL,
    supportScopes: false,
  } as unknown as TenantContracts;
};
```
Adjust field names to the real `TenantContracts` type in `src/lib/types.ts:50-70` and the real factory names generated by typechain from the overlay ABIs (`AgoraGovernorV2__factory` if the JSON is named `AgoraGovernorV2.json`). `foundry` chain in viem has id 31337 already. `getRpcUrlForChain` returns `NEXT_PUBLIC_FORK_NODE_URL` when set, which the compose env points at Anvil.

- [ ] **Step 3: Overlay: UI config**

`infra/agora-next/overlay/src/lib/tenant/configs/ui/fleet.ts` modelled on `b3.ts`, `title: "Fleet Governance"`, plain colours, and toggles:
```ts
toggles: [
  { name: "proposals", enabled: true },
  { name: "delegates", enabled: true },
  { name: "use-archive-for-proposals", enabled: true },
  { name: "use-archive-for-proposal-details", enabled: true },
  { name: "use-archive-for-vote-history", enabled: true },
  { name: "use-daonode-for-voting-power", enabled: true },
  { name: "use-daonode-for-votable-supply", enabled: true },
  { name: "use-daonode-for-proposal-types", enabled: true },
  { name: "delegates/edit", enabled: false },
  { name: "sponsoredVote", enabled: false },
  { name: "sponsoredDelegate", enabled: false },
],
```
Copy the `pages` block from b3 with fleet copy: the governance page description must say, in plain words, that this is a transparency record of a fleet of AI agents and that enforcement in v1 is offchain.

- [ ] **Step 4: Patch 0001, registration edits**

Edits to existing files (all one-line additions or new `case` arms), captured as one patch:
- `src/lib/constants.ts`: `FLEET: "fleet"` in `TENANT_NAMESPACES`.
- `src/lib/tenant/tenantSlugFactory.ts`: `case TENANT_NAMESPACES.FLEET: return "FLEET" as any;` (matching the escape hatch used for TOWNS).
- `src/lib/tenant/tenantContractFactory.ts`, `tenantUIFactory.ts`, `tenantTokenFactory.ts` (`{ name: "Fleet Vote", symbol: "FLEET", decimals: 18, address: <from deployment> }`), `tenant.ts` `BRAND_NAME_MAPPINGS`.
- `src/lib/prismaUtils.ts`: add `case TENANT_NAMESPACES.FLEET:` to each switch pointing at `fleet*` Prisma models (`prismaWeb3Client.fleetProposals` etc.).
- `src/lib/proposals/status/standard.ts`: `case TENANT_NAMESPACES.FLEET: return forVotes;` in both quorum helpers.
- `src/lib/proposalUtils/proposalStatus.ts` (or wherever `getProposalCurrentQuorum` switches): same For-only arm.
- `prisma/schema.prisma`: add `"fleet"` to `datasource.schemas`.
The Dockerfile appends `overlay/prisma/fleet-views.prisma` (the `b3*` views copied with `b3` → `fleet` in model names and `@@schema("fleet")`) to `schema.prisma` before `prisma generate`.

- [ ] **Step 5: ABIs**

Copy `packages/abi/abis/AgoraGovernor.json` to the overlay as `AgoraGovernorV2.json` and `FleetVotes.json` as-is. Check whether typechain's generated factory name collides with the existing `AgoraGovernor.json`; if so keep `AgoraGovernorV2`.

- [ ] **Step 6: Dockerfile**

```dockerfile
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git patch openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY vendor/agora-next /app
COPY infra/agora-next/patches /patches
RUN for p in /patches/*.patch; do patch -p1 < "$p"; done
COPY infra/agora-next/overlay/ /app/
RUN cat prisma/fleet-views.prisma >> prisma/schema.prisma
RUN npm ci
RUN npx prisma generate && npm run generate-typechain
EXPOSE 3000
CMD ["npm", "run", "dev"]
```
Compose env from `infra/agora-next/.env.fleet.example`: `NEXT_PUBLIC_AGORA_INSTANCE_NAME=fleet`, `NEXT_PUBLIC_AGORA_INSTANCE_TOKEN=FLEET`, `NEXT_PUBLIC_AGORA_ENV=dev`, `NEXT_PUBLIC_AGORA_BASE_URL=http://localhost:3000`, `NEXT_PUBLIC_FORK_NODE_URL=http://anvil:8545` (server) plus `NEXT_PUBLIC_FORK_NODE_URL` browser-visible variant pointing at `http://localhost:8545` if the app reads one URL for both; check `src/lib/rpcConfig.ts` and record which. `DATABASE_URL`, `READ_WRITE_WEB2_DATABASE_URL_DEV=postgres://agora:agora@postgres:5432/agora_web2`, `READ_ONLY_WEB3_DATABASE_URL_DEV=postgres://agora:agora@postgres:5432/agora_web3`, `DAONODE_URL_TEMPLATE=http://dao-node:8000`, `ARCHIVE_GCS_BUCKET=fleet-archive-dev` or `ARCHIVE_GCS_BUCKET_OVERRIDE=http://fake-gcs:4443/fleet-archive-dev` (offline), `FLEET_DEPLOYMENT_FILE=/deployments/agora-next-deployment.json` (volume), `JWT_SECRET=<32 chars dev>`, `NEXT_PUBLIC_AGORA_API_KEY=dev`. Leave WalletConnect, Alchemy, EAS, Pinata, Tenderly empty and confirm the app still boots (the Explore report says injected-only wallets work without WalletConnect).

- [ ] **Step 7: Boot and smoke**

`docker compose up -d --build agora-next`, then `curl -sf localhost:3000/proposals | head -c 500` and `curl -sf localhost:3000/delegates`.
Expected: HTML for both. Fix each Prisma error the logs show by adding the missing stub table to the generator (Task 2) and regenerating; list every table that was needed in compatibility notes. The delegates page must show the five members with `1 FLEET` voting power (from DAO Node).

- [ ] **Step 8: Commit**

```bash
git add infra/agora-next infra/docker-compose.yml infra/postgres
git commit -m "feat(infra): Agora Next fleet tenant via patch and overlay

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

### Task 6: Bootstrap script and the M0 end-to-end check

**Files:**
- Create: `infra/scripts/bootstrap-local.sh`, `infra/scripts/write-daonode-config.sh`, `infra/scripts/write-agora-next-deployment.sh`, `infra/scripts/scripted-proposal.sh`, `infra/scripts/wait-for.sh`, `infra/README.md`
- Modify: `docs/compatibility-notes.md`

**Interfaces:**
- Consumes: `deployments/31337/latest.json` (Part 1 manifest), `packages/abi/abis/*.json`.
- Produces: `infra/.env` (TOKEN_ADDRESS, GOVERNOR_ADDRESS, DAO_NODE_START_BLOCK), `infra/dao-node/abis/<address>.json` for token and governor, `deployments/31337/agora-next-deployment.json`.

- [ ] **Step 1: write-daonode-config.sh**

Reads the manifest with `jq`, writes `infra/.env` lines, copies `packages/abi/abis/FleetVotes.json` to `infra/dao-node/abis/<token-lowercase>.json` and `AgoraGovernor.json` to `<governor-lowercase>.json`. Idempotent.

- [ ] **Step 2: write-agora-next-deployment.sh**

Emits the deployment JSON of Task 5 from the manifest.

- [ ] **Step 3: scripted-proposal.sh**

Using `cast` and Anvil's default keys (operator = account 6 per `deployments/configs/local-5.json`):
1. `cast send $LEDGER "openTask(string,uint64)" '<charter json>' 7200 --private-key $OPERATOR_KEY`.
2. Build calldata: `cast calldata "recordDecision(uint256,uint8,uint32,bytes32,string,string)" 1 1 1 $(cast keccak "fetch examples.internal") "" "one-time fetch"`.
3. Member 1 proposes: `cast send $GOVERNOR "propose(address[],uint256[],bytes[],string)" "[$LEDGER]" "[0]" "[$CALLDATA]" $'# Grant exception\n\nfetch examples.internal\n\n#proposalTypeId=0' --private-key $AGENT1_KEY`. Capture the proposal id from the `ProposalCreated` log with `cast receipt ... --json | jq` and `cast decode-event` or by calling `getProposalId`.
4. Sleep past the voting delay (block time 2 s, delay 15 s), then five `castVoteWithReason` calls: For, For, Against, For, Against with the reasons from spec 2.
5. Sleep past the period, `queue`, sleep past the timelock, `execute`. Print `state()` after each stage and the ledger's `exceptionVersion(1, hash)`.

- [ ] **Step 4: bootstrap-local.sh**

Order: `docker compose up -d anvil postgres` → wait → `forge script DeployFleet` (Part 1 command) → `write-daonode-config.sh` → `write-agora-next-deployment.sh` → `docker compose up -d --build dao-node cpls agora-next` (+ `--profile offline fake-gcs` when no GCS creds) → wait for `/v1/progress`, CPLS `/health`, agora-next `/proposals` → create the fake bucket if offline → `scripted-proposal.sh` → trigger a CPLS job after each stage → print the proposal URL `http://localhost:3000/proposals/<id>`.

- [ ] **Step 5: Run it and check every link in the chain**

```bash
bash infra/scripts/bootstrap-local.sh 2>&1 | tee /tmp/bootstrap.log
PID=<printed id>
curl -s localhost:8000/v1/proposals | jq '.proposals | length'                  # 1
curl -s localhost:8000/v1/vote_record/$PID | jq 'length'                          # 5, each with a reason
curl -s "localhost:4443/storage/v1/b/fleet-archive-dev/o" | jq -r '.items[].name' | grep votes/$PID
curl -s localhost:3000/proposals | grep -c "Grant exception"                      # >= 1
curl -s localhost:3000/proposals/$PID | grep -c "Charter forbids"                 # >= 1 (an Against reason)
```
Expected: all as commented. The proposal page must show status `Executed` (the chain says Executed), five votes, and the reasons. If the status shown differs from `cast call $GOVERNOR "state(uint256)" $PID`, the fleet quorum case in Task 5 is wrong or missing; fix it.

- [ ] **Step 6: Record and commit**

Write the M0 evidence block (commands and outputs) and every quirk found into `docs/compatibility-notes.md`. Write `infra/README.md` (how to bring the stack up, ports, where the archive lives, how to switch to a real GCS bucket, how to point at Base Sepolia through env).

```bash
git add infra docs/compatibility-notes.md deployments
git commit -m "feat(infra): bootstrap script and M0 end-to-end proof

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: [private session removed]"
```

---

## Part 2 acceptance (spec M0, stack half)

- `docker compose up` plus `bootstrap-local.sh` produces, from an empty Anvil, a fleet, one executed proposal, and an Agora Next page showing that proposal with five votes and reasons, status matching the chain, and a delegates page with five members.
- DAO Node serves balances, delegates, proposals, and vote records for our contracts in `agora 2.0` mode with the recorded patches.
- CPLS reproduces the archive from an empty bucket (delete the bucket contents, re-trigger the job, re-run the curl checks).
- `docs/compatibility-notes.md` lists every stub table Agora Next needed, every env var it needed, each DAO Node and CPLS env name confirmed from source, and the exact pages verified.
