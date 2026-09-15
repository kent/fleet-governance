# Base Sepolia wallet setup

We can provision experiment wallets in GCP and fund them automatically with Base Sepolia
test ETH. GitHub starts the work, and Secret Manager holds the keys. Start with five agents,
which means nine accounts: deployer, operator, guardian, keeper and five voters.

The GCP Runner is deployed. Wallet generation, faucet automation and the Base Sepolia
deployment are the next stage. No experiment wallets have been generated or funded yet.

As of September 15, 2026, the CDP key passes a read-only authentication check. Both CDP
credentials are stored as enabled version 1 in Secret Manager, verified by the
[GitHub import](https://github.com/kent/fleet-governance/actions/runs/34976004864).
The temporary encrypted GitHub copy was removed. HTTP and WSS RPC credentials are next.

## What you need to do

1. **Create a Coinbase Developer Platform project and Secret API Key.** In the
   [CDP API Keys dashboard](https://portal.cdp.coinbase.com/api-keys/secret), select your
   project, open **Secret API Keys**, and create a key named `fleet-governance-testnet`.
   Save its ID and secret. CDP recommends Ed25519. The faucet needs API authentication;
   its endpoint does not require a CDP Wallet Secret or access to your existing wallet.
   [CDP authentication](https://docs.cdp.coinbase.com/api-reference/v2/authentication)

2. **Create Base Sepolia HTTP and WSS endpoints with your RPC provider.** Confirm
   `eth_getLogs` range limits and WebSocket subscriptions. Base's public endpoints are HTTP
   only, so changing `https://sepolia.base.org` to `wss://` is not sufficient.
   [Base RPC documentation](https://docs.base.org/base-chain/api-reference/rpc-overview)

3. **Store those credentials in Secret Manager during the web3 setup.** Terraform now creates
   the two CDP containers. The infrastructure workflow's `import-cdp` action imports a
   temporary encrypted GitHub secret and verifies the stored values. See the
   [GCP runbook](../infra/gcp/README.md) for that procedure. The HTTP and WSS containers and
   credentials are still pending. Keep values out of workflow inputs, repository files and logs.

   | Secret | Value |
   | --- | --- |
   | `fleet-cdp-api-key-id` | CDP Secret API Key ID |
   | `fleet-cdp-api-key-secret` | CDP Secret API Key secret |
   | `fleet-base-sepolia-rpc-url` | Provider HTTP URL |
   | `fleet-base-sepolia-ws-url` | Provider WebSocket URL |

4. **Review the generated public address table before contract deployment.** The planned
   GitHub workflow should generate nine fresh EOAs on GCP, store their keys directly in
   Secret Manager and return only public addresses and secret version references. Your
   existing wallet's seed and private key stay with you.

5. **Fund and check the accounts.** The workflow should request faucet ETH, confirm the
   resulting balances and compare them with gas estimates before deploying. Allocate more
   to the deployer and keeper. Every account needs gas, including the guardian. The current
   preflight rejects zero balances but does not establish that a balance can finish a run.
   Agent accounts pay their own gas today.

6. **Run a scripted approval/rejection test before the model pilot.** Verify that an approved
   action executes and a rejected action cannot reach the protected operation. Then run
   five model agents. The OpenRouter pilot also needs its separate $1 credit cap, no reset,
   with BYOK usage included. Funding testnet wallets does not set the inference budget.

## How automatic funding would work

CDP accepts external EVM addresses, so we can use the EOAs our Runner already supports.
An authenticated request to `POST https://api.cdp.coinbase.com/platform/v2/evm/faucet` uses:

```json
{"network":"base-sepolia","address":"<experiment public address>","token":"eth"}
```

The published allowance is **0.0001 ETH per request**, with a **0.1 ETH rolling 24-hour
limit** applied at both the CDP user and address level. A faucet request is a small top-up,
not a promise that contract deployment is funded. Requests can be rate-limited or fail.
[CDP faucet API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/faucets/request-funds-on-evm-test-networks)

The implementation should check chain ID `84532`, reuse stored keys on reruns, skip funded
accounts, cap the number of requests and back off on rate limits. Record transaction hashes
and confirm balances before spending. CDP notes that a replacement transaction can make the
returned hash stale, so a missing receipt needs reconciliation rather than another immediate
funding request. Stop with a funding report if the target is not reached.
[CDP transaction response](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/faucets/request-funds-on-evm-test-networks)

For a manual fallback, select Base Sepolia in your wallet: chain ID `84532`, currency ETH,
RPC `https://sepolia.base.org`, explorer `https://sepolia.basescan.org`.
[Base network details](https://docs.base.org/get-started/connect-to-base)
Claim from the [Quicknode faucet](https://faucet.quicknode.com/base/sepolia) or
[Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia), subject to their eligibility
rules, and transfer test ETH to the generated addresses. No mainnet ETH bridge is required.

## Experiment accounts

The current Runner expects these environment variables, populated from Secret Manager in
the next deployment change:

| Account | Runner variable | Purpose |
| --- | --- | --- |
| Deployer | `FLEET_DEPLOYER_KEY` | Deploy the contract suite |
| Operator | `FLEET_OPERATOR_KEY` | Open and manage tasks |
| Guardian | `FLEET_GUARDIAN_KEY` | Pause and intervene |
| Keeper | `FLEET_KEEPER_KEY` | Queue and execute settled decisions |
| Five agents | `FLEET_AGENT_KEY_0` through `FLEET_AGENT_KEY_4` | Propose, delegate and vote |

These are fresh research keys, not the published Anvil development keys. The current Runner
expects raw EOA signing keys, including the guardian. A Safe, hardware wallet or external
guardian signer requires an adapter; it is not wired into this deployment. Retain operator
access to the research guardian key so manual intervention remains possible.

Resetting an experiment should preserve these keys and their remaining test ETH. A fresh
contract deployment gets a new manifest and addresses. Base Sepolia history cannot be erased
by resetting the VM or deleting local files. Rotate accounts only when explicitly requested.

Before the public demonstration, the GCP read-side services still need their Base configuration,
attached-identity GCS access and an explicit archive publishing path. The wallet steps prepare
that phase; they do not mean Base Sepolia is already deployed. See the
[deployment runbook](deployment-runbook.md) for the contract and runtime details.
