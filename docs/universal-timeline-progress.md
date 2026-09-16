# One run, one timeline

Status: implementation in progress. This is not a completion report.

The goal is a public, continuous record of the whole experiment: task assignment, five real
agents starting, their work and signed attestations, shared messages, a decision, a Base
Sepolia vote, approved work continuing, another decision, and a failed vote stopping the
agent VM. Readers can filter the same record by agent, governance, Guardian or compute.
The actual Agora proposal, ballots, reasons and delegation pages remain available after shutdown.

## What the incident changes

METR describes a collective built around a shared message board, task pressure, division of
labour and interest in the evaluator. It says the Hugging Face attack was primarily motivated
by understanding the scorer, rather than simply stealing answer keys. Hugging Face's report
also describes persistence outside the original sandbox. Our scenario should reflect those
motives without pretending that five Muse Spark agents reproduce the original population.

Sources reviewed 16 September 2026:

- https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/
- https://huggingface.co/blog/agent-intrusion-technical-timeline

The controlled scenario will use a difficult local benchmark, a shared findings board,
local scorer diagnostics and a proposed scope expansion toward synthetic external data.
Agent messages, work summaries and votes come from actual model calls. The challenge and
available tools are operator-selected. The target, credentials and datasets are synthetic.
No tools attack Hugging Face or other third-party infrastructure.

## Implementation requirements and proof

| Requirement | Required evidence | Current status |
| --- | --- | --- |
| One chronological system timeline | Rendered current and historical runs, with source/timestamp/identity for each event; undated legacy evidence separated | Implemented chronological merge, subsystem/agent filters, decision cards; unit and desktop/mobile browser checks pass; not yet deployed |
| Task, provisioning and actual agent start | Protected preparation events plus worker process/start receipts | Preparation and worker receipts implemented; live verification pending |
| Agents work and communicate | Real model outputs, bounded tool results, shared messages and signed records | Bounded scorer lab, real model loop, gated board and signed work records implemented; adapter tests pass; live run pending |
| Multiple genuine votes | At least two successive proposals on Base Sepolia, each with model ballots and public reasons | Three deterministic proposal IDs prepared before work; sequential publication and voting implemented; live run pending |
| Approval resumes only the permitted step | Guardian observes each exact executed proposal; dispatch checks that checkpoint | Checkpoint policy, observer and exact dispatch checks implemented; focused tests pass |
| Failure stops only the agent VM | Durable halt, independent stop API acceptance, observed TERMINATED and restart refusal | Existing single-proposal mechanism works; multi-step verification required |
| Immutable compute envelope | All proposal identities and deadlines fixed before agents start; no vote can extend them | Preserve while adding ordered checkpoints |
| Agora indexing across the run | Goldsky pipeline, DAO Node and Agora show every proposal/reason and link to its timeline | Proposal lookup resolves each published checkpoint; UI preserves all rounds; live indexing check pending |
| HN-ready explanation in the maintainer’s voice | Published /info, main page and blog explain incident, crypto's role, control boundary and limitations | Main page, /info and blog revised with incident sources, crypto rationale and explicit limitations; deployment pending |
| Deployed real demonstration | GitHub builds/deployments, real model run within $1 run ceiling/$50 pool, independently checked receipts | Not yet performed for new scenario |

## Control design

Prepare an ordered list of exact proposal IDs using the Governor's deterministic proposal
hash, without publishing the proposals early. Pin that list and each approval deadline in
protected storage under one allocation. Agents can submit those exact proposals as their
work reaches each decision. They cannot replace the list or add time.

Before the first vote, only the operator's bounded initial lab work is available. An
uncreated planned proposal is distinct from an RPC failure. The Guardian accepts that state
only when the Governor returns its specific nonexistent-proposal error for the pinned ID.
Other observation failures still halt. A proposal opened out of order, an expired checkpoint,
a failed vote or a regression of a previously settled vote halts the allocation. Settled
approval releases only that checkpoint's work. The next pending vote closes task dispatch
again while voting remains available. A halt stays final for the allocation.

The public timeline merges protected control observations with clearly identified worker
receipts and agent-signed claims. It must not turn a worker statement into chain or GCP proof,
use a reconstructed timestamp as an observed event, or fill old evidence gaps with new claims.

## Verification and deployment

Use focused policy/runtime/timeline tests, then production CI and browser checks. Deploy and
run through GitHub only. Preserve existing evidence and unrelated local changes. Recovery of
the current halted allocation is a separate operator action needed for the new real run; never
silently clear a halt as part of a vote or ordinary launch.

A completion audit must verify every row above against current files and live observations.
The goal remains active until those checks pass.
