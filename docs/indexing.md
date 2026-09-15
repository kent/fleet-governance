# One indexing path for the research demo

Fleet Governance uses DAO Node, Postgres and CPLS to serve Agora. It does not deploy or
configure a Goldsky subgraph. We should keep that boundary clear instead of maintaining two
competing projections of the same proposals.

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

## Goldsky

The repository's GCP configuration and GitHub workflows contain no Goldsky subgraph, pipeline
or configured Goldsky indexing endpoint. A legacy local-development comment mentions Goldsky
as an upstream RPC fallback; that is not a deployed indexing dependency.

An independently created Goldsky resource should be checked for consumers and then retired
if it duplicates this path. We have not identified or deleted that resource. The reported
scratch-account discount is not a dependency or a cost assumption for this deployment.

For a longer-lived service, move ingestion out of the experiment process into a durable
reader with a block checkpoint, reorg handling and replay. Pick that design explicitly. Do
not add a subgraph alongside DAO Node just to make a missing vote row appear.

## Research limits

The runner currently ingests votes for the proposals it runs. It is not a general-purpose
indexer for arbitrary activity submitted outside the experiment. DAO Node, Postgres, CPLS
and Agora share the worker VM and go offline during a real shutdown. The independent compute
page and evidence store stay online. Keeping Agora continuously available would require a
separate read-side host.
