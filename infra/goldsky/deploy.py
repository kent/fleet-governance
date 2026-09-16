#!/usr/bin/env python3
"""CI-only deployment. Read managed credentials without putting them in logs."""
import json
import os
from pathlib import Path
import subprocess
import urllib.request

def secret(name):
    return subprocess.check_output(['gcloud','secrets','versions','access','1','--secret='+name], text=True).strip()

token = secret('fleet-goldsky-api-token')
request = urllib.request.Request('https://api.goldsky.com/auth/check_token', headers={'Authorization':'Bearer '+token, 'User-Agent':'goldsky-cli/13.13.2'})
with urllib.request.urlopen(request, timeout=20) as response:
    account = json.load(response)
assert account['success'] and account['project']['id'] == 'project_clgwxt6i715vh4aui14jzdg0j', 'Goldsky project must be Agora scratch'
directory = Path.home() / '.goldsky'
directory.mkdir(mode=0o700, exist_ok=True)
auth = directory / 'auth_token'
auth.touch(mode=0o600)
os.chmod(auth, 0o600)
auth.write_text(token)
webhook = secret('fleet-goldsky-webhook-token')
name = 'fleet-governance-history'
existing = subprocess.check_output(['goldsky','secret','list','--no-color'], text=True, stderr=subprocess.DEVNULL)
command = ['goldsky','secret','update',name] if name in existing else ['goldsky','secret','create','--name',name]
result = subprocess.run(command + ['--value', json.dumps({'type':'httpauth','secretKey':'Authorization','secretValue':'Bearer '+webhook}), '--no-color'], capture_output=True, text=True)
if result.returncode:
    raise SystemExit('Goldsky delivery credential configuration failed; no secret diagnostics printed.')
print('Managed delivery credential configured for Fleet only.')
subprocess.run([str(directory / 'bin/turbo'), 'apply', 'infra/goldsky/fleet-base-sepolia.yaml'], check=True)
subprocess.run([str(directory / 'bin/turbo'), 'get', 'fleet-base-sepolia-events', '-o', 'json'], check=True)
