"""Goldsky -> durable raw logs -> DAO Node, with CPLS's existing vote adapter.

Only Goldsky writes normal event history. The Guardian never reads this service.
"""
import asyncio
from contextlib import asynccontextmanager
import hmac
import json
import os
import time

import asyncpg
from eth_abi import decode
from eth_utils import keccak
from fastapi import FastAPI, HTTPException, Request
import httpx
import uvicorn

from events import GOVERNOR, canonical_action, matches, normalize

pool = None
client = None
rpc_cache = {}
write_lock = asyncio.Lock()
VOTE = '0x' + keccak(text='VoteCast(address,uint256,uint8,uint256,string)').hex()
VOTE_PARAMS = '0x' + keccak(text='VoteCastWithParams(address,uint256,uint8,uint256,string,bytes)').hex()

async def rpc(method, params):
    key = json.dumps([method, params])
    cached = rpc_cache.get(key)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    response = await client.post(os.environ['FLEET_RPC_HTTP'], json={'jsonrpc':'2.0','id':1,'method':method,'params':params})
    response.raise_for_status()
    data = response.json()
    if 'error' in data:
        raise RuntimeError('Upstream RPC unavailable')
    result = data['result']
    if len(rpc_cache) > 2000:
        rpc_cache.clear()
    rpc_cache[key] = (time.monotonic() + 2, result)
    return result

@asynccontextmanager
async def lifespan(app):
    global pool, client
    pool = await asyncpg.create_pool(os.environ['DATABASE_URL'], min_size=1, max_size=5)
    client = httpx.AsyncClient(timeout=15)
    await pool.execute('''CREATE TABLE IF NOT EXISTS fleet.raw_logs (
        id text PRIMARY KEY, block_number bigint NOT NULL, block_hash text NOT NULL,
        transaction_hash text NOT NULL, log_index integer NOT NULL, payload jsonb NOT NULL);
        CREATE INDEX IF NOT EXISTS raw_logs_block ON fleet.raw_logs(block_number, log_index);
        CREATE TABLE IF NOT EXISTS fleet.ingest_status (
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), received_at timestamptz,
        deliveries bigint NOT NULL DEFAULT 0, reorgs bigint NOT NULL DEFAULT 0);''')
    yield
    await client.aclose()
    await pool.close()

app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

@app.get('/health')
async def health():
    counts = dict(await pool.fetchrow('SELECT count(*) AS events, max(block_number) AS latest_event_block FROM fleet.raw_logs'))
    status = await pool.fetchrow('SELECT received_at::text, deliveries, reorgs FROM fleet.ingest_status WHERE singleton')
    return {**counts, **(dict(status) if status else {}), 'source': 'goldsky', 'chainId': 84532}

async def project_vote(conn, log):
    if log['address'] != GOVERNOR or log['topics'][0] not in (VOTE, VOTE_PARAMS):
        return
    with_params = log['topics'][0] == VOTE_PARAMS
    fields = decode(['uint256', 'uint8', 'uint256', 'string'] + (['bytes'] if with_params else []), bytes.fromhex(log['data'][2:]))
    proposal, support, weight, reason = fields[:4]
    voter = '0x' + log['topics'][1][-40:]
    await conn.execute('''INSERT INTO fleet.votes
        (transaction_hash,proposal_id,voter,support,weight,reason,block_number,params,contract,chain_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,84532)
        ON CONFLICT (contract,proposal_id,voter) DO UPDATE SET
        transaction_hash=EXCLUDED.transaction_hash,support=EXCLUDED.support,weight=EXCLUDED.weight,
        reason=EXCLUDED.reason,block_number=EXCLUDED.block_number,params=EXCLUDED.params''',
        log['transactionHash'], str(proposal), voter, str(support), weight, reason,
        int(log['blockNumber'],16), '0x' + fields[4].hex() if with_params else '0x', GOVERNOR)

@app.post('/goldsky')
async def ingest(request: Request):
    expected = 'Bearer ' + os.environ['FLEET_INGEST_TOKEN']
    if not hmac.compare_digest(request.headers.get('authorization',''), expected):
        raise HTTPException(401, 'Unauthorized')
    body = await request.body()
    if len(body) > 2_000_000:
        raise HTTPException(413, 'Batch too large')
    try:
        rows = json.loads(body)
        if not isinstance(rows, list): rows = [rows]
        if not 1 <= len(rows) <= 1000: raise ValueError()
        events = [normalize(row) for row in rows]
    except (ValueError, KeyError, TypeError):
        raise HTTPException(400, 'Invalid Fleet log batch')
    try:
        async with write_lock:
            # Check the current block hash so a replayed orphan cannot restore a
            # removed ballot, even if Goldsky retries changes out of order.
            blocks = {}
            for _, _, log in events:
                number = log['blockNumber']
                if number not in blocks:
                    block = await rpc('eth_getBlockByNumber', [number, False])
                    if not block: raise RuntimeError('RPC behind source')
                    blocks[number] = block['hash'].lower()
            actions = [(key, log, canonical_action(deleted, log['blockHash'], blocks[log['blockNumber']])) for key, deleted, log in events]
            if any(action == 'retry' for _, _, action in actions):
                raise RuntimeError('RPC has not observed rollback yet')
            async with pool.acquire() as conn, conn.transaction():
                reorgs = 0
                for key, log, action in actions:
                    if action == 'ignore': continue
                    if action == 'delete':
                        removed = await conn.fetchval('DELETE FROM fleet.raw_logs WHERE id=$1 AND block_hash=$2 RETURNING transaction_hash', key, log['blockHash'])
                        if removed:
                            await conn.execute('DELETE FROM fleet.votes WHERE transaction_hash=$1 AND contract=$2', removed, GOVERNOR)
                            reorgs += 1
                        continue
                    previous_hash = await conn.fetchval('SELECT block_hash FROM fleet.raw_logs WHERE id=$1', key)
                    if previous_hash and previous_hash != log['blockHash']:
                        reorgs += 1
                    await conn.execute('''INSERT INTO fleet.raw_logs VALUES ($1,$2,$3,$4,$5,$6::jsonb)
                        ON CONFLICT (id) DO UPDATE SET block_number=EXCLUDED.block_number,
                        block_hash=EXCLUDED.block_hash,payload=EXCLUDED.payload''',
                        key, int(log['blockNumber'],16), log['blockHash'], log['transactionHash'], int(log['logIndex'],16), json.dumps(log))
                    await project_vote(conn, log)
                await conn.execute('''INSERT INTO fleet.ingest_status(singleton,received_at,deliveries,reorgs) VALUES (true,now(),1,$1)
                    ON CONFLICT (singleton) DO UPDATE SET received_at=now(),
                    deliveries=fleet.ingest_status.deliveries+1,reorgs=fleet.ingest_status.reorgs+$1''', reorgs)
        return {'accepted':len(events)}
    except Exception:
        # Keep credentials, incoming reasons and RPC diagnostics out of logs.
        print('Goldsky batch will retry; no delivery acknowledged.', flush=True)
        raise HTTPException(503, 'Retry delivery')

@app.post('/rpc')
async def read_rpc(request: Request):
    body = await request.json()
    method, params = body.get('method'), body.get('params', [])
    try:
        if method == 'web3_clientVersion': result = 'Fleet/Goldsky-event-store'
        elif method == 'eth_chainId': result = '0x14a34'
        elif method == 'eth_getLogs':
            query = params[0]
            async def number(value):
                return int(await rpc('eth_blockNumber', []) if value == 'latest' else value, 16)
            start, end = await number(query.get('fromBlock','0x0')), await number(query.get('toBlock','latest'))
            addresses = query.get('address', [])
            if isinstance(addresses, str): addresses = [addresses]
            addresses = [address.lower() for address in addresses]
            rows = await pool.fetch('SELECT payload FROM fleet.raw_logs WHERE block_number BETWEEN $1 AND $2 ORDER BY block_number,log_index', start, end)
            result = [log for row in rows if matches(log := json.loads(row['payload']), addresses, query.get('topics', []))]
        elif method in ('eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_call'):
            result = await rpc(method, params)
        else:
            return {'jsonrpc':'2.0','id':body.get('id'),'error':{'code':-32601,'message':'Read method unavailable'}}
        return {'jsonrpc':'2.0','id':body.get('id'),'result':result}
    except Exception:
        return {'jsonrpc':'2.0','id':body.get('id'),'error':{'code':-32000,'message':'History source temporarily unavailable'}}

if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=8010, access_log=False)
