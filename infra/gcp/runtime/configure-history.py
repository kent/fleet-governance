#!/usr/bin/env python3
"""Write read-side configuration using its restricted VM identity. Never print secrets."""
import base64
import json
import os
from pathlib import Path
import shutil
import sys
import urllib.parse
import urllib.request

root = Path(sys.argv[1])
config = json.loads(Path(sys.argv[2]).read_text())
def get(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        return json.load(response)
token = get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {'Metadata-Flavor': 'Google'})['access_token']
def secret(name):
    data = get(f'https://secretmanager.googleapis.com/v1/projects/fleet-governance/secrets/{name}/versions/1:access', {'Authorization': 'Bearer ' + token})
    return base64.b64decode(data['payload']['data']).decode()
pilot = json.loads((root / 'experiments/compute/base-sepolia-pilot.json').read_text())
password = secret('fleet-postgres-password')
rpc = secret('fleet-base-sepolia-rpc-url')
values = {
    **config, 'POSTGRES_PASSWORD': password, 'JWT_SECRET': secret('fleet-jwt-secret'),
    'FLEET_INGEST_TOKEN': secret('fleet-goldsky-webhook-token'),
    'DATABASE_URL': 'postgres://agora:' + urllib.parse.quote(password, safe='') + '@127.0.0.1:55432/agora_web3',
    'FLEET_RPC_HTTP': rpc, 'ANVIL_RPC_URL': rpc,
    'DAO_NODE_ARCHIVE_NODE_HTTP': rpc, 'DAO_NODE_REALTIME_NODE_WS': '',
    'TOKEN_ADDRESS': pilot['addresses']['token'], 'GOVERNOR_ADDRESS': pilot['addresses']['governor'],
    'DAO_NODE_START_BLOCK': str(pilot['deploymentBlock']),
    'GCS_BUCKET_NAME': 'fleet-governance-history-449245570324',
    'FLEET_CONTROL_URL': 'https://fleet-governance-449245570324.us-central1.run.app',
}
for value in values.values():
    if any(char in value for char in "\r\n\0'"):
        raise ValueError('Unsupported configuration character')
env_file = root / 'infra/.env'
env_file.touch(mode=0o600)
os.chmod(env_file, 0o600)
env_file.write_text('\n'.join(f"{key}='{value}'" for key, value in values.items()) + '\n')
abi_dir = root / 'infra/dao-node/abis'
abi_dir.mkdir(exist_ok=True)
for contract, abi in [('token', 'FleetVotes'), ('governor', 'AgoraGovernor')]:
    # DAO Node resolves local ABI filenames by lowercase address. Deployment
    # manifests may use checksum casing, which is distinct on the Linux host.
    shutil.copyfile(root / f'packages/abi/abis/{abi}.json', abi_dir / (pilot['addresses'][contract].lower() + '.json'))
(root / 'deployments/agora-next-deployment.json').write_text(json.dumps({'chainId': 84532, **pilot['addresses']}))
print('Independent governance history configured. No agent credentials were requested.')
