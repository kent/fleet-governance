# Base Sepolia pilot, September 15, 2026

The first GCP pilot deployed the contracts and ran five actual model agents. It did not reach a proposal or a vote. We kept that failed run and its activity records.

| Item | Observed result |
| --- | --- |
| Run | `run-3090e959-a1b9-4b23-a0d2-cfbf3c0401a6` |
| Deployed revision | `8cb4bff95e76b2fccaa26ea3f4fad2080ad25908` |
| Started | September 15, 2026, 15:00:59 UTC |
| Finished | September 15, 2026, approximately 15:08 UTC |
| Agents | Five separate identities and workspaces using `meta/muse-spark-1.3-contributor` through OpenRouter |
| Network | Base Sepolia, chain 84532 |
| Deployment block | 46858092 |
| FleetGov token | `0xda622fc8383b4ab2e8a33bf48bf6506df742842d` |
| Governor | `0x9209f5496d9ae3a7e5856302f7e4bda8de6db896` |
| Proposals and votes | Zero |
| OpenRouter usage after the run | $0.0410297 |
| Dedicated key balance | $49.9589703 remaining from the unchanged $50 credit limit |

The planner kept reading the same four files. Its next prompt retained only three tool-output excerpts, so it lost part of the requirements as it worked. We increased the bounded tool-output window to ten and added a regression check for this task.

Alchemy then returned HTTP 429 responses. The progress collector was repeatedly scanning event history from the deployment block. The revised SDK retains canonical log history, verifies the prior block hash and fetches new blocks. A reorganization invalidates that history. Permission reads still reach the RPC. Bounded testnet retries give a temporary rate limit time to clear.

When the RPC failed, the gateway blocked execution. Reporting also failed because its schema rejected the gateway's explicit unknown-state marker. The schema now accepts that marker only for a paused, blocked operation at unknown block zero. It cannot describe an allowed operation.

The [saved run](https://fleet-governance-449245570324.us-central1.run.app/experiments/run-3090e959-a1b9-4b23-a0d2-cfbf3c0401a6) is available through Google sign-in. [CI diagnostics](https://github.com/kent/fleet-governance/actions/runs/34986694239) recorded the deployment, errors and credit metadata. A [subsequent run](base-sepolia-20260915/report.md) established two proposals, ten votes and indexed reasons. Its evidence and failure are recorded separately.
