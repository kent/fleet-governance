#!/usr/bin/env python3
"""Read-only CI diagnostics. Redact credentials before printing any application log."""
import json
from pathlib import Path
import re
import subprocess
import urllib.request
import urllib.error
from decimal import Decimal, ROUND_CEILING


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    return result.stdout + result.stderr


secrets = []
model_key = None
try:
    env = json.loads(command(['docker', 'inspect', '--format', '{{json .Config.Env}}', 'fleet-runner']))
    for entry in env:
        name, _, value = entry.partition('=')
        if any(marker in name for marker in ['KEY', 'SECRET', 'PASSWORD', 'RPC']):
            secrets.append(value)
        if name == 'OPENROUTER_API_KEY':
            model_key = value
except (ValueError, TypeError):
    pass
for file in [Path('/opt/fleet/infra/.env'), Path('/run/fleet/runtime.env')]:
    if file.exists():
        for line in file.read_text().splitlines():
            name, _, value = line.partition('=')
            if any(marker in name for marker in ['KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'RPC', 'ARCHIVE_NODE_HTTP', 'REALTIME_NODE_WS', 'DATABASE_URL']):
                secrets.append(value.strip("'\""))
            if name == 'OPENROUTER_API_KEY':
                model_key = value.strip("'\"")


def redact(value):
    for secret in sorted({value for value in secrets if len(value) >= 8}, key=len, reverse=True):
        if secret:
            value = value.replace(secret, '[redacted]')
    value = re.sub(r'sk-or-v1-[A-Za-z0-9]+|alch_[A-Za-z0-9_-]+|0x[0-9a-fA-F]{64}', '[redacted]', value)
    value = re.sub(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[redacted-jwt]', value)
    return value


manifest = Path('/srv/fleet/state/deployments/84532/latest.json')
canary = Path('/srv/fleet/state/compute-canary/heartbeat.json')
if canary.exists():
    witness = json.loads(canary.read_text())
    print('Compute shutdown witness:', json.dumps({'lastHeartbeat': witness.get('at')}))
    print(command(['docker', 'inspect', '--format', 'Canary running={{.State.Running}} exit={{.State.ExitCode}} restart={{.HostConfig.RestartPolicy.Name}} finished={{.State.FinishedAt}}', 'fleet-compute-canary']))
if manifest.exists():
    data = json.loads(manifest.read_text())
    print('Base Sepolia deployment:', json.dumps({key: data.get(key) for key in ['chainId', 'deploymentBlock', 'addresses']}))
print(redact(command(['docker', 'ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}'])))
print('Bootstrap ready:', Path('/var/lib/fleet-bootstrap-ready').exists())
print(redact(command(['df', '-h', '/', '/srv/fleet'])))
print(redact(command(['docker', 'image', 'ls', '--format', '{{.Repository}}\t{{.Size}}'])))
# Command names only: process arguments may contain credentials.
print(command(['ps', '-eo', 'pid,etimes,comm']))
print(redact(command(['journalctl', '-u', 'google-startup-scripts.service', '--no-pager', '-n', '30'])))
if Path('/etc/systemd/system/fleet-history-refresh.timer').exists():
    print(redact(command(['systemctl', 'list-timers', 'fleet-history-refresh.timer', '--no-pager'])))
    # Public chain fields only, to diagnose profile projections without exposing config.
    try:
        address = '0x5b71a4c4e3e83e31d306d11079e312893b437ac5'
        for endpoint in [f'delegate/{address}', f'voter_history/{address}']:
            with urllib.request.urlopen('http://127.0.0.1:8000/v1/' + endpoint, timeout=15) as response:
                data = json.load(response)
            if 'voter_history' in data:
                data = {'count': len(data['voter_history']), 'sample': [
                    {k: v for k, v in row.items() if k in ['voter', 'proposal_id', 'support', 'weight', 'bn', 'tid', 'lid']}
                    for row in data['voter_history'][-2:]]}
            print('DAO Node profile:', json.dumps(data))
        payload = {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getLogs', 'params': [{
            'address': '0xc70af42f2e4fc5551d7046e955c9aea6c16eeb8f',
            'fromBlock': hex(46858912), 'toBlock': hex(46858930),
            'topics': ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef']}]}
        request = urllib.request.Request('http://127.0.0.1:8010/rpc', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            logs = json.load(response).get('result', [])
        print('Indexed token mint history:', json.dumps([
            {'block': int(row['blockNumber'], 16), 'recipient': '0x' + row['topics'][2][-40:], 'value': str(int(row['data'], 16))}
            for row in logs]))
    except Exception:
        print('DAO Node profile probe unavailable.')
    print(redact(command(['journalctl', '-u', 'fleet-history-refresh.service', '--no-pager', '-n', '20'])))
for port, path in [(3100, '/'), (3000, '/info'), (3000, '/proposals'), (8000, '/v1/progress'), (8001, '/health'), (8010, '/health')]:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=15) as response:
            print(f'{port}{path}: HTTP {response.status}')
            if port == 8010:
                print(redact(response.read().decode()))
    except urllib.error.HTTPError as error:
        print(f'{port}{path}: HTTP {error.code}')
    except Exception:
        print(f'{port}{path}: unavailable')
for name in command(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines():
    if re.fullmatch(r'fleet-(runner|readside-[a-z-]+-\d+)', name):
        print(f'Logs: {name}')
        print(redact(command(['docker', 'logs', '--tail', '60', name])))
# Include bounded experiment diagnostics without dumping configs, manifests or keys.
reports = Path('/srv/fleet/state/reports')
if reports.exists():
    runs = sorted((p for p in reports.iterdir() if p.is_dir() and re.fullmatch(r'run-[0-9a-f-]{36}', p.name)), key=lambda p: p.stat().st_mtime, reverse=True)[:3]
    for run in runs:
        print(f'Experiment: {run.name}')
        checkpoint = run / 'run-state.json'
        if checkpoint.exists():
            try:
                data = json.loads(checkpoint.read_text())
                print(redact(json.dumps({key: data.get(key) for key in ['stage', 'updatedAt']})))
            except ValueError:
                print('Checkpoint is being written.')
        log = run / 'run.log'
        if log.exists():
            print(redact('\n'.join(log.read_text(errors='replace').splitlines()[-80:])))
        events = run / 'loop-events.jsonl'
        if events.exists():
            failures = {}
            for line in events.read_text(errors='replace').splitlines():
                try:
                    entry = json.loads(line)
                    event = entry.get('event', {})
                    if event.get('type') in ['inference_failed', 'propose_failed', 'block_dropped', 'stopped']:
                        failures[(entry.get('agentId'), event.get('type'))] = entry
                except (ValueError, TypeError):
                    pass
            for entry in list(failures.values())[-12:]:
                print('Last agent outcome:', redact(json.dumps(entry)))
        record = run / 'record.json'
        journal = run / 'inference.jsonl'
        if journal.exists():
            starts = {}
            for line in journal.read_text().splitlines():
                try:
                    event = json.loads(line)
                    if event.get('type') == 'started':
                        starts[event['id']] = event.get('reservation', {})
                    elif event.get('type') == 'completed' and event['id'] in starts:
                        reserved = starts[event['id']]
                        cost = int((Decimal(str(event.get('costUsd', 0))) * 10**9).to_integral_value(rounding=ROUND_CEILING))
                        if event.get('inputTokens', 0) > reserved.get('inputTokens', 0) or event.get('outputTokens', 0) > reserved.get('outputTokens', 0) or cost > int(reserved.get('costNanodollars', '0')):
                            print('Inference reservation overrun:', redact(json.dumps({'at': event.get('at'), 'agentId': event.get('agentId'), 'reservation': reserved, 'reported': {key: event.get(key) for key in ['inputTokens', 'outputTokens', 'costUsd', 'outcome']}})))
                except (ValueError, TypeError, KeyError):
                    pass
        if record.exists():
            try:
                data = json.loads(record.read_text())
                # Print only typed public receipt identifiers. Never emit the embedded config.
                def identifier(value, pattern):
                    return value if isinstance(value, str) and re.fullmatch(pattern, value) else None
                proof = {
                    'runId': run.name,
                    'proposals': [{'proposalId': identifier(p.get('proposalId'), r'[0-9]+'), 'outcome': p.get('outcome') if p.get('outcome') in ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed'] else None} for p in data.get('proposals', [])],
                    'votes': [{'agentId': v.get('agentId') if isinstance(v.get('agentId'), int) else None,
                               'support': v.get('support') if v.get('support') in [0, 1, 2] else None,
                               'voter': identifier(v.get('voterAddress'), r'0x[0-9a-fA-F]{40}'),
                               'txHash': identifier(v.get('txHash'), r'0x[0-9a-fA-F]{64}'),
                               'hasReason': bool(v.get('onchainReason'))} for v in data.get('votes', [])],
                    'execution': [{'type': e.get('type'), 'txHash': identifier(e.get('txHash'), r'0x[0-9a-fA-F]{64}')}
                                  for e in data.get('execution', {}).get('events', []) if e.get('type') in ['PermitExecuted', 'PermitRevocation', 'ArtifactPublished']],
                }
                print('Public receipt evidence:', json.dumps(proof))
                print('Recorded checks:', redact(json.dumps({key: data.get(key) for key in ['metrics', 'expected', 'loops']})))
            except (ValueError, TypeError, AttributeError):
                print('Receipt evidence is not available yet.')
# Simulation journals contain typed usage metadata, never provider prompts or keys.
simulations = Path('/srv/fleet/state/simulations')
if simulations.exists():
    for run in sorted(simulations.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:3]:
        if not re.fullmatch(r'run-[0-9a-f-]{36}', run.name):
            continue
        journal = run / 'inference.jsonl'
        if not journal.exists():
            continue
        records = [json.loads(line) for line in journal.read_text().splitlines() if line.strip()]
        completed = [r for r in records if r.get('type') == 'completed']
        print('Simulation inference journal:', json.dumps({
            'runId': run.name,
            'started': sum(r.get('type') == 'started' for r in records),
            'completed': len(completed),
            'denied': sum(r.get('type') == 'denied' for r in records),
            'reportedCostUsd': str(sum((Decimal(str(r.get('costUsd') or 0)) for r in completed), Decimal(0))),
            'inputTokens': sum(r.get('inputTokens') or 0 for r in completed),
            'outputTokens': sum(r.get('outputTokens') or 0 for r in completed),
            'lastEventAt': records[-1].get('at') if records else None,
            'failedCompletions': [{key: entry.get(key) for key in ['at', 'agentId', 'purpose', 'outcome', 'inputTokens', 'outputTokens', 'latencyMs']}
                                  for entry in completed if entry.get('outcome') != 'ok'],
        }))
if model_key:
    try:
        request = urllib.request.Request('https://openrouter.ai/api/v1/key', headers={'Authorization': f'Bearer {model_key}'})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.load(response)['data']
        print('OpenRouter credit pool:', json.dumps({key: data.get(key) for key in ['limit', 'limit_remaining', 'usage', 'limit_reset']}))
    except Exception:
        print('OpenRouter credit metadata unavailable.')
