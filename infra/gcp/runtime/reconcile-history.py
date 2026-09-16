#!/usr/bin/env python3
"""Reconcile DAO Node and CPLS after durable Goldsky deliveries.

Runs on fleet-readside only. No GCP compute credentials or API calls are used.
"""
import json
from pathlib import Path
import subprocess
import time
import urllib.request

def request(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:' + path, data=data,
            headers={'Content-Type':'application/json'}), timeout=15) as response:
        return json.load(response)

def main(force=False):
    root = Path('/opt/fleet').resolve()
    current = request('8010/health')
    cursor = Path('/srv/fleet/state/history-refresh.json')
    old = json.loads(cursor.read_text()) if cursor.exists() else {'deliveries':-1,'reorgs':0}
    if current.get('events',0) == 0 or (not force and current.get('deliveries',0) == old['deliveries']):
        return
    # Goldsky can deliver events older than DAO Node's polling lookback. Rebuild
    # this small pilot projection from the local store so delayed batches and
    # reorgs cannot leave the archive permanently missing a proposal or ballot.
    subprocess.run(['docker','compose','-f',str(root / 'infra/gcp/docker-compose.yml'),
        '-f',str(root / 'infra/gcp/history-compose.yml'),'--project-directory',str(root / 'infra'),
        'restart','dao-node'], check=True, stdout=subprocess.DEVNULL)
    time.sleep(5)
    # DAO Node must have consumed the latest stored events before CPLS snapshots it.
    progress = request('8000/v1/progress')
    if int(progress.get('block',0)) < current['latest_event_block']:
        raise RuntimeError('DAO Node is still catching up')
    pilot = json.loads((root / 'experiments/compute/base-sepolia-pilot.json').read_text())
    payload = {'type':'sync_daonode','payload':{'infra_dao_slug':'fleet','logic':'refresh_list',
        'sources':['dao_node'],'reset':True,'config':{'schema':'fleet','dao_slug':'FLEET',
        'index_tenant_prefix':'fleet','features':{'oodao':False,'snapshot_proposals':False,'dao_node_proposals':True},
        'deployment':{'chain_id':84532,'gov':{'address':pilot['addresses']['governor']},'token':{'address':pilot['addresses']['token']}}}}}
    job = request('8001/jobs', payload)['job_id']
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        status = request('8001/jobs/' + job)['status']
        if status == 'failed': raise RuntimeError('Archive refresh failed')
        if status == 'completed':
            temp = cursor.with_suffix('.tmp')
            temp.write_text(json.dumps({'deliveries':current['deliveries'],'reorgs':current['reorgs']}))
            temp.replace(cursor)
            print('Governance archive refreshed from Goldsky and DAO Node.')
            return
        time.sleep(2)
    raise RuntimeError('Archive refresh is still pending')

if __name__ == '__main__':
    try:
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument("--force", action="store_true", help="Rebuild derived archives after an indexer deployment")
        main(force=parser.parse_args().force)
    except Exception:
        raise SystemExit('History refresh incomplete; the timer will retry.')
