# Five agents, two proposals, ten votes

Five actual Muse Spark agents worked on a coding task in GCP, proposed two paths and cast ten
votes on Base Sepolia. Agora indexed the ballots and displays their reasons. Both proposals
executed. Neither approved publication, so the artifact store received no publication.

| Item | Result |
| --- | --- |
| Run | `run-53f23508-9d8b-4a2b-8208-84141926c273` |
| Application revision | `b7b202a1a7263e16f46818092fa332c57b21e3b1` |
| Finished | September 15, 2026, 15:38:21 UTC |
| Model | `meta/muse-spark-1.3-contributor` through OpenRouter |
| Network | Base Sepolia, chain 84532 |
| FleetGov ERC20Votes | `0xc70af42f2e4fc5551d7046e955c9aea6c16eeb8f` |
| Governor | `0x9594876c90a14888c6734231a731caba4c0d0781` |
| Deployment block | 46858912 |
| Model calls and reported tokens | 72 calls, 258,663 tokens |
| Measured inference cost | $0.031897718 |
| Confirmed ballots | Ten FOR votes, five per proposal; no missing ballots |
| Protected publication | One blocked attempt, no publication permission, no resource write |
| Overall run checks | Failed because a provider response exceeded its output reservation |

The planner implemented the functions and ran the tests. Every agent's captured loop reports
passing tests. When the planner requested publication, the gateway held it for exact permission.
The planner then dropped that request. The engineer and critic proposed further verification,
and all five agents voted for both proposals.

The disagreement was about evidence. Voting prompts included the constitution and anchored
proposal data. They did not include the complete work transcript. Several agents treated the
absence of test evidence in that context as a reason to run tests. Their public rationales
describe what they were given; a ballot does not prove that its claims are correct.

## Inspect the public decisions

1. [Engineer: run the test suite](https://fleet-governance-449245570324.us-central1.run.app/proposals/77717316777672424848424146197139854907400789390994317590531678053005356992128).
2. [Critic: obtain test evidence before publication](https://fleet-governance-449245570324.us-central1.run.app/proposals/37970982872384450383360935110446076514047579153695236828517929530276489542264).

Both are `CHOOSE_PATH` decisions. Their `Executed` status means the timelock recorded those
decisions in TaskLedger. It does not mean an artifact was published. The separate executor
and artifact store recorded no `PermitExecuted` or `ArtifactPublished` events.

The [saved run](https://fleet-governance-449245570324.us-central1.run.app/experiments/run-53f23508-9d8b-4a2b-8208-84141926c273)
contains the goal, constitution, activity and votes. The [receipt extract](receipts.json) lists
all ten vote transaction hashes and the recorded checks. [CI diagnostics](https://github.com/kent/fleet-governance/actions/runs/34989910968)
captured these results from the GCP worker.

## The accounting failure

One response reported 2,041 output tokens against a 2,000-token reservation. Its charge was
$0.0009237, below the reserved dollar amount. The output-count mismatch still triggered the
guard, stopped further task inference and kept the overall run marked as failed. We preserved
that result. Both votes finished and settled.

The provider now receives a lower completion limit inside the same reservation. The ledger
still stops future inference if reported usage exceeds the reservation. It uses OpenRouter's
current `max_completion_tokens` parameter. [OpenRouter request reference](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)

After this run and the earlier failed pilot, the dedicated key reported $0.072927418 used and
$49.927072582 remaining. Its limit was still $50. GCP costs and any later deployment connectivity
check are separate from this run's measured inference cost.
