#!/usr/bin/env python3
"""Check actual runtime permissions and start an isolated shutdown witness."""
import json
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from uuid import uuid4

req = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', headers={'Metadata-Flavor': 'Google'})
with urllib.request.urlopen(req, timeout=10) as response:
    token = json.load(response)['access_token']

def request(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {}

permissions = ['compute.instances.start', 'compute.instances.stop', 'compute.instances.setMachineType', 'compute.instances.setScheduling', 'compute.instances.setServiceAccount', 'compute.instances.setMetadata', 'compute.instances.delete']
status, data = request('https://compute.googleapis.com/compute/v1/projects/fleet-governance/zones/us-central1-a/instances/fleet-research/testIamPermissions', {'permissions': permissions})
print(json.dumps({'permissionProbeStatus': status, 'grantedPermissions': data.get('permissions', [])}))
assert status == 200 and not data.get('permissions'), 'Runtime has unexpected compute permissions or the check was inconclusive'
for prefix in ['allocations', 'states', 'blocked-runs']:
    status, _ = request('https://storage.googleapis.com/upload/storage/v1/b/fleet-governance-control-449245570324/o?uploadType=media&ifGenerationMatch=0&name=' + prefix + '/permission-probe-' + str(uuid4()) + '.json', {'probe': True})
    assert status == 403, 'Runtime policy write was not rejected'
print(json.dumps({'runtimeComputePermissions': [], 'allocationWrite': 403, 'haltWrite': 403, 'blockedRunWrite': 403}))

directory = Path('/srv/fleet/state/compute-canary')
directory.mkdir(mode=0o777, exist_ok=True)
directory.chmod(0o777)
subprocess.run(['docker', 'rm', '-f', 'fleet-compute-canary'], capture_output=True, check=False)
script = "const fs=require('fs');setInterval(()=>fs.writeFileSync('/witness/heartbeat.json',JSON.stringify({at:new Date().toISOString(),pid:process.pid})),1000)"
result = subprocess.run(['docker', 'run', '-d', '--name', 'fleet-compute-canary', '--restart=no', '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=128m', '--cpus=0.1', '--pids-limit=32', '-v', str(directory)+':/witness', 'node:22-alpine', 'node', '-e', script], capture_output=True, text=True, check=True)
print(json.dumps({'canaryContainer': result.stdout.strip(), 'network': 'none', 'restart': 'no'}))
