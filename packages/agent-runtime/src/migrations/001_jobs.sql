-- Durable job records for the agent runtime worker (spec 10.8). Applied by both
-- PgJobStore.migrate() and PgNonceStore.migrate(); every statement is idempotent
-- (CREATE TABLE IF NOT EXISTS), so it is safe to run from either store, in any order,
-- any number of times.

CREATE TABLE IF NOT EXISTS jobs (
  chain_id INTEGER NOT NULL,
  governor TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  action_type TEXT NOT NULL,
  state TEXT NOT NULL,
  input_block_number BIGINT,
  input_block_hash TEXT,
  manifest_hash TEXT,
  provider_id TEXT,
  model_id TEXT,
  prompt_version TEXT,
  inference_latency_ms INTEGER,
  usage JSONB,
  vote JSONB,
  public_reason TEXT,
  nonce INTEGER,
  tx_hash TEXT,
  receipt JSONB,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, governor, proposal_id, agent_address, action_type)
);

-- Durable nonce bookkeeping for @fleet/sdk's NonceManager (spec 10.1, 10.8: the worker and
-- keeper apps share this database for persistent nonces, not just job records).
CREATE TABLE IF NOT EXISTS nonces (
  account TEXT PRIMARY KEY,
  next INTEGER NOT NULL,
  pending JSONB NOT NULL
);
