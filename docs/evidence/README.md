# Recorded local experiments

These are scripted runs on isolated Anvil chains from September 14, 2026. Each uses actual
membership, governance, votes and resource checks. No model API calls or public-chain transactions
were made. Transaction hashes refer to the original local chain, not a public explorer.

| Run | Members | Ballots | Result |
| --- | ---: | ---: | --- |
| [Contract execution](execution-2000-1789411525744/report.md) | 2,000 | 4,000 | Rejected publication blocked; approved publication executes once |
| [Small contract execution](execution-5-1789411395881/report.md) | 5 | 10 | Same enforcement checks with a small electorate |
| [Tool gateway](scale-2000-1789408328458/report.md) | 2,000 | 4,000 | Rejected fetch sends zero canary requests; approved amendment permits one |
| Model task-loop publication, [approved](model-publication-20260914/approve.md) and [rejected](model-publication-20260914/reject.md) | 3 | 6 | The normal task loop proposes a file's exact permission; approval publishes once, rejection leaves revision zero |

The first three demonstration directories contain:

- `report.md`: readable results and individual public ballots.
- `scale-summary.json`: counts, outcomes, runtime and deployment gas.
- `executor-checks.json`: actual execution probes and their results. Contract probes include successful and reverted transaction hashes.
- `manifest.json`: deployed contract addresses, code hashes and membership.
- `deployment-transactions.json`: deployment receipts and gas usage.
- `verification.json`: compared fields and capture block numbers.
- `SHA256SUMS`: checksums of the packaged files.

`model-publication-20260914` contains the two reports, `results.json` with public ballots and
resource events, and checksums. These integration scenarios use scripted provider responses.
They exercise the production model task loop, but do not measure real model judgement. The
tests also bypass the gateway to check contract rejection, change file bytes to require new
approval, and reconstruct governance and resource events from the chain.

Run `python3 scripts/verify-evidence.py` from the repository root to check the bundled files
against their checksums. `verification.json` records the original comparison of the live run
with a separate chain capture. It is a reported result, not an independent trust anchor.

The demo generates `record.json`, `chain-recaptured.json` and `chain-state.json` under its local
run directory. Those larger generated files are excluded from Git. The original captures remain
in the author's local run directories. If compressed copies of both records are present beside
the report, the verification script also compares their governance and resource data.

The checksums detect changes to the supplied files. They do not make the reports an
independent public-chain record. Re-run `execution-demo` or `scale-demo` to reproduce the behaviour
on a new chain. Run IDs, addresses, block numbers and transaction hashes may differ.

The local chain snapshot is the JSON-encoded result of Anvil's `anvil_dumpState` method. It uses
public development accounts and local test state. Model keys, private environment files and
live-model transcripts are not part of the published evidence.
