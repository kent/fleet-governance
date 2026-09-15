import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { FleetClient } from '/opt/fleet/packages/sdk/dist/index.js';
import { googleRequest, readSecret } from '/opt/fleet/apps/runner/dist/cloud/google.js';
import { insertVoteRow, triggerCplsJob } from '/opt/fleet/apps/runner/dist/pipeline/cpls-sync.js';
const require = createRequire('/opt/fleet/apps/runner/package.json');
const { Pool } = require('pg');
let pool;
try {
  const evidence = await (await googleRequest('storage', 'storage/v1/b/fleet-governance-control-449245570324/o/evidence%2Flatest.json?alt=media')).json();
  const manifest = JSON.parse(readFileSync('/opt/fleet/deployments/84532/latest.json', 'utf8'));
  if (manifest.chainId !== 84532 || typeof evidence.scripted !== 'boolean' || evidence.outcome !== 'Defeated'
    || evidence.allocation?.governor.toLowerCase() !== manifest.addresses.governor.toLowerCase()) throw new Error('Wrong current fleet for shutdown evidence.');
  const rpcUrl = await readSecret('fleet-base-sepolia-rpc-url');
  const client = new FleetClient({ rpcUrl, chainId: 84532, addresses: manifest.addresses, deploymentBlock: BigInt(evidence.startBlock) });
  await client.assertChain();
  const votes = await client.listVotes(BigInt(evidence.proposalId));
  if (votes.length !== 5 || votes.some(vote => !evidence.votes.some(saved => saved.txHash === vote.txHash))) throw new Error('Recorded votes did not match the chain.');
  pool = new Pool({ host: '127.0.0.1', port: 55432, user: 'agora', password: process.env.POSTGRES_PASSWORD, database: 'agora_web3' });
  for (const vote of votes) await insertVoteRow(pool, { proposalId: evidence.proposalId, transactionHash: vote.txHash,
    blockNumber: vote.blockNumber, chainId: 84532, voter: vote.voter, support: vote.support, weight: vote.weight, reason: vote.reason, contract: manifest.addresses.governor });
  await triggerCplsJob(fetch, 'http://127.0.0.1:8001', { governor: manifest.addresses.governor, chainId: 84532 }, { timeoutMs: 120000 });
  console.log(JSON.stringify({ proposalId: evidence.proposalId, source: 'Base Sepolia VoteCast events', indexedVotes: votes.length, scripted: evidence.scripted, synced: true }));
} catch {
  console.error('Compute vote indexing failed. Private connection details withheld. Existing votes were not removed.');
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
