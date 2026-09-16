#!/usr/bin/env python3
"""Refresh CPLS after deliveries; rebuild DAO Node after a confirmed reorg.

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

def main():
    root = Path('/opt/fleet').resolve()
    current = request('8010/health')
    cursor = Path('/srv/fleet/state/history-refresh.json')
    old = json.loads(cursor.read_text()) if cursor.exists() else {'deliveries':-1,'reorgs':0}
    if current.get('events',0) == 0 or current.get('deliveries',0) == old['deliveries']:
        return
    if current.get('reorgs',0) != old['reorgs']:
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
        main()
    except Exception:
        raise SystemExit('History refresh incomplete; the timer will retry.')
