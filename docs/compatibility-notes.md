# Compatibility notes

## Foundry image tag

`ghcr.io/foundry-rs/foundry:v1.7.1` exists and was pulled successfully
(digest `sha256:8347b728d5d393dac1c018691b36f506d23b9dcd78341d40ea0fcb11c3a19cdd`).
`infra/anvil/Dockerfile` uses that tag directly; no fallback to `:latest`
was needed.

## Agora Next Prisma web2/web3 split

`vendor/agora-next/src/app/lib/prisma.ts` exports `prismaWeb2Client` and
`prismaWeb3Client`, but both names are bound to the same `PrismaClient`
instance, built from a single `DATABASE_URL`:

```ts
const prismaWeb2Client = prismaClient;
const prismaWeb3Client = prismaClient;
```

`prisma/schema.prisma` also declares only one `datasource db` block with one
`schemas = [...]` list covering every tenant schema (`agora`, `config`,
`b3`, and the rest). There is no actual database split today; the two
exported names look like preparation for a future split that has not
happened.

Per the plan's fallback rule for this case, `infra/postgres/gen-stub.ts`
puts everything (the `fleet`-mapped `b3` views, plus the shared `agora` and
`config` tables) into `agora_web3`, and also writes the same `agora`/
`config` stub tables into `agora_web2` (`infra/postgres/init/03-agora-web2-stub.sql`),
so either connection string renders empty reads instead of failing on a
missing table.

## Local Postgres port conflict during verification

This machine also runs a Homebrew-managed `postgresql@16` service bound to
`127.0.0.1:5432` and `[::1]:5432`. That claims `localhost:5432` ahead of
Docker's published port for `infra-postgres-1`, so `psql
postgres://agora:agora@localhost:5432/...` from the host resolves to the
Homebrew server (and fails with `role "agora" does not exist`) unless that
service is stopped first (`brew services stop postgresql@16`) or the
verification is run against the container directly
(`docker exec infra-postgres-1 psql -U agora -d agora_web3 -c '\dt fleet.*'`).
This is an environment quirk of this host, not a stack issue: the
Homebrew service was stopped for the verification run in the Task 2 report
and restarted afterward.
