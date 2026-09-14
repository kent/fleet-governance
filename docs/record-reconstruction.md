# Rebuild the decision from its public record

A saved JSON file is useful. It is not proof that an agent voted or that a resource changed.
`fleet capture --from-chain` reads the deployed contracts again and rebuilds those claims.

The existing record supplies the deployment manifest, task and proposal references. For a
single-task run, capture also discovers proposals the saved file missed. Multi-task scripted
records use their listed proposal references. Keep the original deployment manifest and the
matching chain available when reproducing a run.

## What capture checks

1. Read `ProposalCreated` and the task's decision trace. Require one zero-value call to the
   configured task ledger, decode its `recordDecision` calldata, and check it against the
   hook's `DecisionProposed` event.
2. Rebuild the decision kind, payload hash, summary, task and current Governor outcome. Resolve
   the proposer through the fleet registry. Old values in the JSON do not override these reads.
3. Check the structured proposal description against the calldata, proposer identity and
   deployment domain. Only a matching description supplies a verified tool action or contract
   permission. Keep an invalid description in the raw events, mark it unverified, and remove
   any cached capability.
4. Read the actual ballots, reasons and transaction hashes, and resolve voter identities from
   the registry. Local model responses stay attached only to the same proposal and voter.
   A cached ballot missing from chain loses its claimed support, reason and transaction hash.
5. Rebuild fees from transaction receipts. Read publication events, permit events and artifact
   state at a captured block. Check that the resource block did not change during that read.

A verified description means it matches the public commitment. It does not mean the vote
passed, the permission remains usable, or publication happened. Those are separate checks.
The execution section records the resource result, including revision zero after rejection.

Proposal discovery and state read errors fail capture. They do not silently produce a report
that claims complete reconstruction. The RPC endpoint and supplied deployment are still trust
inputs. This command does not create a consensus proof or make an editable report immutable.

## What remains local

Fixture labels, expected outcomes, test results, model response objects, jobs, gateway logs,
timings and software versions remain offchain bookkeeping. Capture does not certify them.
Missing jobs are not onchain ballots. Saved reports should be labelled as captures when their
original chain is unavailable.

The unit checks cover corrupted metadata, missing proposals, conflicting descriptions,
proposal-specific ballot attribution and unavailable RPC reads. The publication integration
uses fresh Anvil deployments and the normal task loop with scripted model responses. It removes
or corrupts saved evidence before calling the capture CLI, then checks the recovered permission,
outcome, voter identities, reasons and artifact state. It tests enforcement and reconstruction,
not spontaneous model behaviour.

```sh
FLEET_INTEGRATION=1 pnpm exec vitest run --project integration \
  apps/runner/src/model-run.integration.test.ts -t 'normal task loop publication'
```
