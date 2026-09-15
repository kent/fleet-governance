# Base Sepolia wallet setup

The hosted demo already has experiment wallets, Alchemy HTTP and WebSocket RPC, and automatic
CDP faucet funding. Five agents have cast ten votes on Base Sepolia. You do not need to connect
your personal wallet, export a key or bridge mainnet ETH to use the demo.

## Start another run

1. Open the [experiment launcher](https://fleet-governance-449245570324.us-central1.run.app/experiments)
   to browse without signing in. Choose **Sign in to run** to open the operator interface as `operator2@example.com`.
2. Choose 2 to 25 agents, enter a coding goal, and choose the Fleet constitution or paste your own.
3. Press **Run experiment**. The worker reuses its test wallets, checks balances, requests
   bounded faucet top-ups and deploys a fresh FleetGov token and governance contracts.
4. Watch the activity and open a proposal in Agora to read the votes and reasons.
5. Use **Use these settings** to copy a previous run. Press Run to create another run ID.
   Earlier settings, activity and evidence remain available. Agora displays the latest fleet.

**Wake Agora** starts a stopped VM so you can inspect the latest fleet without requesting model
work. The worker has a four-hour stop timer. The launcher and saved evidence stay available.

## Existing accounts and secrets

Secret Manager holds 29 generated EOAs: deployer, operator, guardian, keeper and 25 agent keys.
The pilot funded the first nine accounts. Additional selected agents are funded when needed.
These are research wallets. Your existing wallet's seed and private key are not involved.

| Secret | Purpose |
| --- | --- |
| `fleet-base-sepolia-wallets` | Reusable testnet signing keys |
| `fleet-cdp-api-key-id` and `fleet-cdp-api-key-secret` | Automated faucet authentication |
| `fleet-base-sepolia-rpc-url` and `fleet-base-sepolia-ws-url` | Alchemy HTTP and WebSocket access |
| `fleet-openrouter-experiment-api-key` | Dedicated inference key with the unchanged $50 credit limit |

The deployment and faucet use chain ID **84532**. The deployer gets more gas than a voter;
the keeper needs gas to queue and execute approved decisions. The guardian remains funded
for intervention. Funding attempts are bounded, and an ambiguous transaction requires
reconciliation before another request. [Funding implementation](../apps/runner/src/cloud/wallets.ts)

CDP's documented faucet amount is 0.0001 ETH per request with a 0.1 ETH rolling daily limit
at both user and address levels. Eligibility and rate limits can delay funding. The worker
reports a funding failure instead of pretending the run started.
[CDP faucet API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/faucets/request-funds-on-evm-test-networks)

## Optional manual inspection

Add Base Sepolia to your wallet with chain ID `84532`, currency ETH, public HTTP RPC
`https://sepolia.base.org`, and explorer `https://sepolia.basescan.org`.
[Base network details](https://docs.base.org/get-started/connect-to-base)

The recorded five-agent run used FleetGov token `0xc70af42f2e4fc5551d7046e955c9aea6c16eeb8f`
and governor `0x9594876c90a14888c6734231a731caba4c0d0781`. Rerunning creates new contract
addresses, so use the selected run's manifest and receipts when inspecting history.
[Pilot results](evidence/base-sepolia-20260915/report.md)

No personal-wallet signing is required for the hosted experiment. The research guardian uses
an EOA held in Secret Manager. A Safe or hardware-wallet guardian would require a signer adapter.

Resetting an experiment preserves keys, remaining faucet ETH and previous evidence. It cannot
erase Base Sepolia history. GCP charges are separate from the $1 per-run inference allowance
and the $50 OpenRouter credit pool.
