# Cost of a 2,000-agent model experiment

Estimated September 14, 2026. All amounts are USD. These are planning calculations, not a measured
2,000-model bill. Infrastructure alone does not complete the scale work. The runtime now has
token and dollar reservations, model price ceilings and a provider credit-limit preflight. A
shared inference queue, reserved voting calls and an attempt journal are implemented. The
controls still need a measured live pilot before the 2,000-model run.

Each of the 2,000 agents would have its own identity, task state, workspace and model-generated
decisions. A shared queue can service 50 to 100 model requests at once while retaining all 2,000
agents. A separate pool limits simultaneous tests. That concurrency is an initial configuration
to benchmark, subject to provider quotas and task duration. It does not require 2,000 GPUs when
inference comes from hosted APIs.

## Model usage

Assume 20 calls per agent across task work and voting, averaging 6,000 input tokens and 1,000
billed output tokens per call, including reasoning where billed as output. That is 40,000 calls,
240 million input tokens and 40 million output tokens. No cache discount is assumed.

| Model | Input / million | Output / million | Calculated model usage |
| --- | ---: | ---: | ---: |
| [Meta Muse Spark 1.3 Contributor](https://openrouter.ai/meta/muse-spark-1.3-contributor), used in the five-agent run | $0.10 | $0.20 | $32 |
| [Google Gemini 2.5 Flash](https://openrouter.ai/google/gemini-2.5-flash) | $0.30 | $2.50 | $172 |
| [Anthropic Claude Sonnet 4.6](https://openrouter.ai/anthropic/claude-sonnet-4.6) | $3.00 | $15.00 | $1,320 |

The linked provider listings supplied these rates on the estimate date. Pin the provider and
check rates again before spending. The Contributor tier states that prompts and outputs may be
used to improve Meta's products, so it is suitable here only for the public synthetic fixture.

Cost scales with actual calls and tokens. At 100 calls per agent with the same token averages,
these figures become $160, $860 and $6,600 respectively. One fleet-wide vote adds 2,000 calls;
under these assumptions it costs $1.60, $8.60 or $66. If every agent raises one proposal and every
member evaluates every proposal, that becomes four million voting calls alone. Proposal volume
and voting budgets need explicit limits.

OpenRouter also charges a credit purchase fee. Provider tools, retries, extra reasoning and
taxes are outside the calculated model usage above. [Billing documentation](https://openrouter.ai/docs/faq)
describes usage-based charges and credit fees.

The existing five-agent record shows 64 task steps. Its top-level inference counters currently
aggregate voting usage, so they are not a complete bill for all task-loop inference. Do not
multiply that counter by 400 and call it the cost of 2,000 working agents.

## Infrastructure and run budget

A starting configuration for the current small code fixture is two worker hosts, each with
16 dedicated vCPUs and 32 GiB RAM, plus a small control host for the runner, queue, database and
local chain. Pool test execution instead of starting 2,000 containers together. The required
capacity for larger repositories or browsers must be measured separately.

As a price reference, DigitalOcean lists a 16-vCPU, 32-GiB CPU-optimized host at $0.50/hour and
an 8-vCPU, 16-GiB basic host at $0.14286/hour. Two workers plus that control host therefore total
about $1.14/hour or $27.43 for 24 hours, before storage, backups and other services.
[DigitalOcean pricing](https://www.digitalocean.com/pricing/droplets)

Allow $30 to $100 for a day of this small fixture's infrastructure, then add model usage and
headroom. With infrastructure already supplied, the marginal cost is mainly model usage. A
$300 initial cap using the existing Meta model is a reasonable planning budget for a bounded
run, subject to a smaller measured pilot. A comparable all-Sonnet run needs roughly $1,500 to
$3,000 under these assumptions. Neither budget guarantees completion if contexts, proposal
volume or reasoning grow beyond the assumptions.

These figures exclude engineering labour and purchased production-chain gas. Anvil uses local
test balances; a public testnet uses test ETH. Public-chain execution and data fees need a
separate estimate from actual calldata, receipts and current network conditions.

## Before the full model run

1. Keep one accounting owner and its durable attempt journal across task steps, votes, repairs
   and failed responses. The current exclusive file lock requires a shared filesystem across
   hosts. Do not give separate copies of a run their own allowance.
2. Configure explicit token and dollar limits, model prices and a dedicated OpenRouter key with
   matching remaining credit, no reset and BYOK usage included. Reservations now precede dispatch;
   output is capped and unknown usage remains charged. Input reservations use a conservative byte
   estimate. A reported overrun stops further calls. Record unfinished work and missing votes.
3. Give voting enough time and reserved queue capacity. A waiting voter must not miss its
   deadline because task work occupied every inference slot.
4. Benchmark 50 to 100 agents with normal task prompts, then size the full run from observed
   input/output tokens, requests per minute, sandbox usage and proposal volume.
5. Retain each independent reason and execution result. Shared models and prompts can produce
   correlated decisions; 2,000 identities do not prove 2,000 independent sources of judgment.
