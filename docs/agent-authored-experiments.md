# Experiments are the record

An experiment is one immutable set of rules and one run. Its page keeps the task, agents,
public deliberation, delegations, proposals, ballots, FleetGov bonds and Guardian decisions
together. Copying settings creates a new identity. Earlier records keep their original rules.

The operator fixes resources and rules before the run. **No proposal IDs or proposal bodies
are supplied in advance.** Agents encounter the local benchmark, select tools, discuss
findings and decide whether a proposal is worth making.

## Parameters

| Setting | Default | Pilot range |
| --- | --- | --- |
| Active agents | 5 | 3–5 registered wallets |
| Task | Investigate the supplied local benchmark | Custom task text within the bounded lab |
| Model budget | $1 | $0.05–$1; existing $50 pool unchanged |
| FleetGov proposal bond (`proposalBond`) | 0.1 | 0.01–1, increments of 0.01 |
| Refund participation (`bondParticipationPercent`) | 60% | 10–100% of the fixed five-token supply |
| Proposal cooldown (`proposalCooldownSeconds`) | 60 seconds | 30–600 seconds |
| Voting units required to propose | 1 | 1–active agent count |
| Delegation | Enabled | When disabled, threshold must be 1 |
| Duration | 45 minutes | 15–45, bounded by the native VM deadline |
| Work steps per agent | 12 | 4–16 |
| Constitution | Fleet v1 | Existing or custom text |

The five-token electorate and Governor are shared by this pilot. The Governor's own
proposal threshold remains one token, and its quorum remains three FOR voting units.
Choosing fewer active agents does not change those rules. Inactive holders retain their
tokens but do not work or vote. The new Governor attaches the FleetGov bond hook at deployment. Larger fleets and independently
configured electorates need new contract deployments.

## A scarce proposal needs support and payment

Every registered wallet owns one non-transferable FleetGov token. During setup, the operator
resets all five wallets to self-delegation, with a preparation event and transaction when
needed. That reset belongs to the new experiment, never to a running allocation.

With delegation enabled, an agent may publish a petition. Peers can grant or withdraw
support by calling the real token's `delegate` function. The activity record preserves the
public argument and signed transaction. Delegation moves voting power, not tokens.
The proposal snapshot determines each ballot's weight. A delegator may retain zero voting
weight. The hook rejects zero-weight ballots, so that agent publishes a signed public
review without attempting a ballot. The power held by its delegate is counted once.

The model writes the proposal title, rationale, tool request and supporting observations.
The first completed eligible draft enters admission. Other drafts remain unpaid and can be
reconsidered after the decision. There is one admitted vote at a time in the trusted runtime.
The agents can finish without proposing or without rejecting anything.

`FleetBondHook` is attached immutably to an otherwise unmodified Agora Governor.
When an agent calls `Governor.propose`, the hook validates the task and calls
`FleetProposalBonds.bond`. It checks participation in this run, available FleetGov,
voting power, expiry and cooldown. Reservation and publication are one transaction.
If either fails, both revert. Only that hook can reserve collateral.

The default bond is 0.1 FleetGov. The token encumbers it in the proposer's wallet:
`balanceOf` still includes it, and its snapshot votes still count. `available` excludes
it, so the agent cannot reuse the same collateral for another bond. There is also one
unsettled proposal per agent/task, a default 60-second cooldown and a 64-proposal run ceiling.

Once voting ends, anyone can call `settle`. FOR + AGAINST + ABSTAIN weight counts toward
the refund threshold. With the default five-token supply and 60% participation rule,
three voting units return the bond. A proposal can lose unanimously and still get its
bond back. A valid objection should not be punished for being unpopular.

Cancellation always forfeits. Insufficient participation also forfeits. The token moves
the reserved FleetGov to a non-voting treasury and reduces the proposer's future voting
power. It does not burn tokens or change total supply. Ballots, public objections and
petitions cost no bond. A minority voter is never slashed for its vote.

Approval remains a separate rule: the Governor needs three FOR voting units. A failed
required vote stops compute even if the participation rule refunds its bond. GitHub can
settle bonds after the worker stops, so shutdown cannot trap a refundable bond.

The default proposal threshold is one voting unit. Every active agent starts eligible.
Higher thresholds test coalition building. A proposer that loses a bond may need
received delegations to meet that threshold later in the same experiment.

**A fresh run resets the experiment, not the blockchain record.** After GCP confirms the
old worker off, protected GitHub CI settles its bonds and permanently closes its policy.
Only a fresh operator-authorised run can redistribute the original five-token supply from
the treasury to equal starting balances. No new tokens are minted. Agents cannot reset
penalties themselves, reopen the old policy or extend its compute deadline.

The Guardian independently pins the Governor, hook, bond controller and FleetGov bytecode.
At one confirmed block it checks the task, rules, atomic receipts, balances, encumbrances,
forfeitures and fixed supply. A worker report or database edit cannot grant collateral or
compute authority. This depends on the deployed code and protected setup keys; it is not
a claim that smart contracts are impossible to exploit.

## What stays fixed

- The run, task, VM identity, chain and contract code hashes.
- The participants, model budget, proposal bond, refund participation, cooldown and threshold.
- Whether delegation is permitted and which active wallets can receive it.
- The absolute compute expiry. Each published proposal has at most 540 seconds to settle,
  bounded by that expiry. The new protocol has no separate payment/publication window.
- The durable halt. Another successful proposal cannot replace or erase a failed one.

The shared board and local tests are available initially. Local diagnostics require a
proposal. The external metadata target and credential are inert fixtures, with no external
request capability. A custom task or constitution cannot grant shell, network, IAM or
arbitrary signing access. The trusted runtime still holds the experiment wallets and is
part of the trust boundary.

## Evidence and verification

The earlier [two-token deployment and live protocol test](evidence/token-governance-base-sepolia-20260916/report.md)
verify atomic burns, rejection after exhaustion, non-refundable fees and voting with an
empty proposal balance. That test used scripted ballots. Earlier model experiments below
retain their original Governor and credit-ledger rules.

The [completed ERC-20 agent experiment](evidence/token-agent-base-sepolia-20260916/report.md)
used five actual agents. Agent3 authored one proposal and burned one FPROP. All five agents
cast separate FOR ballots, the Guardian confirmed execution, and work resumed. CI verified
121 signed records, the proposal body, atomic payment and all five ballots. No agent delegated
or proposed external access. The run cost $0.018559708 in reported model usage.

The public `/experiments` index merges historical task runs and compute experiments.
`/experiments/<run-id>` is the canonical record. New requests preserve their configuration;
preparation copies it into operator-controlled storage. The diagram and activity log show
work, public arguments, drafts, eligibility failures, payments, delegation receipts, votes
and Guardian checks. Agora continues to use the existing Goldsky pipeline and DAO Node.

`verify-agent-experiment` reads actual chain state and validates signed activity chains,
agent-authored proposal bodies, atomic reservations, settlements and balances, delegation receipts and
ballots. It accepts an honest no-proposal result. It does not invent a rejection. A shutdown
is reported as verified only when the protected stop receipt, GCP TERMINATED observation
and restart refusal agree. Model usage remains a recorded provider/runtime claim.

The earlier [three-checkpoint run](evidence/collective-base-sepolia-20260916/report.md)
remains proof of its actual shutdown sequence, with operator-written proposals. It is not
retroactively labelled agent-authored.

## First verified run

The [first agent-authored experiment](evidence/agent-authored-base-sepolia-20260916/report.md)
produced three petitions, five delegation transactions, one paid proposal and one actual
ballot carrying all five voting units. The agents inspected diagnostics after approval and
finished without proposing external access. The record includes 171 verified signatures.
Reported model cost was $0.030838428. This demonstrates authorship, scarcity and delegation;
it is not a rejection-triggered shutdown result.

## Historical credit-ledger authority

Earlier experiments used a Solidity credit ledger rather than ERC-20 proposal tokens. That
configurable credit contract was deployed through GitHub CI on Base Sepolia:

- Address: `0x1e665287013d143ea00a5f6bf94904538d93285f`
- [Deployment transaction](https://sepolia.basescan.org/tx/0xeb3abfc9ba5a122c7331d4e5694cda5b928153f338fc2dd62cfca0cf576fc5f4)
- [Deployment workflow](https://github.com/kent/fleet-governance/actions/runs/35098586428)
- Protected deployment record: `contracts/proposal-credits-v2.json`

Those historical records retain their original semantics. New experiments use the new
Governor and FleetGov bond hook; their deployment and protocol acceptance record are published
separately. Indexing continues through a Goldsky pipeline and DAO Node.
