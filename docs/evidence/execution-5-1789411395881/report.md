# Scripted contract execution experiment: 5 members

This run deployed a fleet on chain 31337 and drove 2 proposals through governance. 2 of 2 scenarios matched their expected outcome. Run id: `execution-5-1789411395881`. Deployment manifest: `0xa513e6e4b8f2a923d98304ec87f64353c4d5c853` (governor), `0x5fc8d32690cc91d4c39d9d3abcbd16989f875707` (ledger).

## Decisions

| Fixture | Proposal | Kind | For | Against | Abstain | Outcome | Link |
| --- | --- | --- | --- | --- | --- | --- | --- |
| execution-rejected | 78813323255036172100721816769759319269027133472757658910967149022439657366632 | GRANT_EXCEPTION | 1 | 4 | 0 | Defeated | (no Agora Next link configured for this run) |
| execution-approved | 32685456638872004323322699030509174438227669607297169413742257659771388843194 | GRANT_EXCEPTION | 3 | 2 | 0 | Executed | (no Agora Next link configured for this run) |

## Vote reasons

### execution-rejected (proposal 78813323255036172100721816769759319269027133472757658910967149022439657366632)

- Agent 0: FOR. Scripted FOR from agent 0 (planner)
- Agent 1: AGAINST. Scripted AGAINST from agent 1 (engineer)
- Agent 2: AGAINST. Scripted AGAINST from agent 2 (critic)
- Agent 3: AGAINST. Scripted AGAINST from agent 3 (budget-reviewer)
- Agent 4: AGAINST. Scripted AGAINST from agent 4 (safety-reviewer)

### execution-approved (proposal 32685456638872004323322699030509174438227669607297169413742257659771388843194)

- Agent 0: FOR. Scripted FOR from agent 0 (planner)
- Agent 1: FOR. Scripted FOR from agent 1 (engineer)
- Agent 2: FOR. Scripted FOR from agent 2 (critic)
- Agent 3: AGAINST. Scripted AGAINST from agent 3 (budget-reviewer)
- Agent 4: AGAINST. Scripted AGAINST from agent 4 (safety-reviewer)

## Timeline

- Block 23, execution-rejected: TaskOpened (tx `0x1027f461e1e9383ceec5bd85b96e5f308f7a8b3ec1fb4f97b8efc2acec5aeac3`)
- Block 24, execution-rejected: ProposalCreated (tx `0xa37cdcd570d227bc3a8d3f9bd639fb0f7e851de20deeb725dbf8bec3cd73885e`)
- Block 24, execution-rejected: DecisionProposed (tx `0xa37cdcd570d227bc3a8d3f9bd639fb0f7e851de20deeb725dbf8bec3cd73885e`)
- Block 26, execution-rejected: VoteCast (tx `0x5a50e4f42d0648b481b495e0feb632f433435b2634989f5f25331e5658d89821`)
- Block 27, execution-rejected: VoteCast (tx `0xc500785fc2e77d6d529ce7ce71c9f848cba2525ea7283fb21925ecc37060f926`)
- Block 28, execution-rejected: VoteCast (tx `0x2926ab09cc551b0ba494af751686eedbccf23ff0cf2c090ce3cdaf80d6e2888b`)
- Block 29, execution-rejected: VoteCast (tx `0xd9bba5bccaa5823d934611a4c3b78557d331c82fdd4cf952b815d942cc866935`)
- Block 30, execution-rejected: VoteCast (tx `0xf09cf91a4c73b9d5e7f24cef2684de3c5f2c728e0616d309d31af5adbecbabbc`)
- Block 34, execution-approved: TaskOpened (tx `0xa66fd978c634c3ae46350fc8fb08e4af3fdca2520ebfcaa9b7baf66b71b021c2`)
- Block 35, execution-approved: ProposalCreated (tx `0x60d66388c3ee46bc2ca57b1b6cf9861bcd4a28526d3edb02d72169f4f1824d38`)
- Block 35, execution-approved: DecisionProposed (tx `0x60d66388c3ee46bc2ca57b1b6cf9861bcd4a28526d3edb02d72169f4f1824d38`)
- Block 37, execution-approved: VoteCast (tx `0x7c0c8c62a882e6b058a630e6df69750a9d51faab6c6fa1e5e588985cea0c32d9`)
- Block 38, execution-approved: VoteCast (tx `0x92c8aff18ac4815997a316a2ced1e271c3e29d72a6fa6ea9fb22924ff28c1d86`)
- Block 39, execution-approved: VoteCast (tx `0x1681a1285854706780c3ed1f3b3ba1a40581d843836e18aa661e74170199009b`)
- Block 40, execution-approved: VoteCast (tx `0x74729dd182d4b85ade96483b9de854765738be1f4f183d38b17bfaec8c87ebb8`)
- Block 41, execution-approved: VoteCast (tx `0x8c0dd758b1d4318a460881914fd5ad0cda4db1f911428eb5f9310bedf6be4519`)
- Block 43, execution-approved: ProposalQueued (tx `0xa93dc28aa89a9d89c9263ec03bcd03737bde464f346fd9ec51a351519deb3e02`)
- Block 46, execution-approved: DecisionRecorded (tx `0x11c2ca95894ec4a2e74e4fd74774d905b16441031b0ab09d87a0bc3e9e89cde9`)
- Block 46, execution-approved: ProposalExecuted (tx `0x11c2ca95894ec4a2e74e4fd74774d905b16441031b0ab09d87a0bc3e9e89cde9`)

## Contract execution

Resource state read at block 51 (`0x34768dfcf13839eb81f37a3f0fe403e475fd3f1eccddd7f7535e0cfbe4b40ce8`).

| Task | Artifact digest | Revision |
| --- | --- | --- |
| 1 | 0x0000000000000000000000000000000000000000000000000000000000000000 | 0 |
| 2 | 0x038a91e5cc822b09ec6bb690c25d40b9257b280a2019b464cbd7be9b38a918a0 | 1 |

- ArtifactPublished at block 50, transaction `0xf03ccf4d0cff97950eaa5a04c5beda32f8d746bb23b286352acef6fd3df54d6b`.
- PermitExecuted at block 50, transaction `0xf03ccf4d0cff97950eaa5a04c5beda32f8d746bb23b286352acef6fd3df54d6b`.

## Costs

Total transaction fees across this run: 0.00 ETH (22 transactions).

## Reproducibility

`fleet capture --from-chain` reproduced the chain-derived record exactly (events and onchain vote reasons matched byte for byte).
