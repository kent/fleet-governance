# Pipeline ingestion, DAO Node and Agora

Fleet Governance uses event ingestion, DAO Node, Postgres and CPLS to serve Agora. Our
architecture choice is pipelines over subgraphs. DAO Node owns the governance projection;
the event pipeline feeds its read-side data. We do not build a second governance projection
in a subgraph.

The deployed path is:

1. DAO Node reads the current Fleet Governor through the configured Base Sepolia RPC.
2. The runner reads confirmed `VoteCast` events from that same Governor. It inserts the
   proposal ID, voter, weight, support, reason, block and transaction into `fleet.votes` in
   Postgres. Inserts are idempotent. This is an adapter for CPLS's existing vote source,
   not a separate subgraph.
3. CPLS combines the proposal data and Postgres votes and writes the archive Agora reads.
4. Agora renders the proposals and reasons. After a shutdown, the recovery workflow can
   reread the saved proposal's actual chain events and restore the vote projection.

The compute controller does not use any of those projections to authorise execution. It
reads the exact required proposal states directly from the configured RPC and checks chain,
Governor bytecode, block consistency and freshness. An indexer outage can affect the display;
it cannot turn a rejected vote into compute permission.

## Goldsky uses direct event pipelines

When we connect Goldsky, use a pipeline sourced directly from Base Sepolia chain data.
Filter to the Fleet contract addresses, decode the events and deliver them to the database
that serves this read path. Goldsky supports dataset sources and Postgres sinks in its
[pipeline configuration](https://docs.goldsky.com/mirror/reference/config-file/pipeline).
Do not use a subgraph-entity source: putting a pipeline after a subgraph would keep the
duplicate stack a collaborator flagged.

The division of work is explicit:

- **Pipeline:** ingest chain events, checkpoint progress and deliver replayable records.
- **DAO Node and CPLS:** project governance data into the format Agora consumes.
- **Agora:** display proposals, ballots and reasons.
- **Compute controller:** independently verify execution authority against the chain.

The runner's current `VoteCast` adapter is the bounded research implementation of the
ingestion step. A durable pipeline should replace that adapter as the normal writer after
we verify matching proposal IDs, voters, support, weight, reasons and transaction identities.
Keep replay idempotent and test reorg handling. Do not leave two competing normal writers.
The recovery import remains an explicit repair operation.

The repository's GCP configuration and GitHub workflows contain no Goldsky subgraph, pipeline
or configured Goldsky indexing endpoint. A legacy local-development comment mentions Goldsky
as an upstream RPC fallback; that is not a deployed indexing dependency.

An independently created Goldsky subgraph should be checked for consumers and then retired
after any needed pipeline replacement is verified. We have not identified or deleted that resource. The reported
scratch-account discount is not a dependency or a cost assumption for this deployment.

For a longer-lived service, move ingestion out of the experiment process. Keep its database
connection private or use an authenticated delivery endpoint; the current worker-local
Postgres is not a public Goldsky sink. Pipeline credentials belong in managed secrets and
pipeline definitions and deployment changes belong in GitHub. Do not add a subgraph
alongside DAO Node just to make a missing vote row appear.

## Research limits

The runner currently ingests votes for the proposals it runs. It is not a general-purpose
indexer for arbitrary activity submitted outside the experiment. DAO Node, Postgres, CPLS
and Agora share the worker VM and go offline during a real shutdown. The independent compute
page and evidence store stay online. Keeping Agora continuously available would require a
separate read-side host.
