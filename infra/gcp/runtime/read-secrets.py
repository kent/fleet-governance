#!/usr/bin/env python3
"""Read pinned Secret Manager versions using the VM identity. Never print values."""
import base64
import json
import os
from pathlib import Path
import tempfile
import urllib.request


def read_json(url, headers):
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def main():
    versions = json.loads(Path('/etc/fleet/secret-versions.json').read_text())
    token = read_json(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        {'Metadata-Flavor': 'Google'},
    )['access_token']
    names = {
        'OPENROUTER_API_KEY': 'fleet-openrouter-experiment-api-key',
        'POSTGRES_PASSWORD': 'fleet-postgres-password',
        'JWT_SECRET': 'fleet-jwt-secret',
        'FLEET_OPERATOR_EMAILS_JSON': 'fleet-operator-emails',
    }
    lines = ['NODE_ENV=production', 'NEXT_TELEMETRY_DISABLED=1']
    config_path = Path('/etc/fleet/worker-config.json')
    if config_path.exists():
        config = json.loads(config_path.read_text())
        allowed = {'FLEET_REVISION', 'FLEET_CONTROL_URL', 'FLEET_WORKER_ENABLED', 'FLEET_DAO_IMAGE', 'FLEET_CPLS_IMAGE', 'FLEET_AGORA_IMAGE'}
        if set(config) != allowed:
            raise ValueError('Unexpected worker configuration fields')
        for name, value in config.items():
            if not isinstance(value, str) or not value or any(char in value for char in '\r\n\0'):
                raise ValueError('Invalid worker configuration value')
            lines.append(f'{name}={value}')
    for variable, secret in names.items():
        version = str(versions[secret])
        if not version.isdecimal() or int(version) < 1:
            raise ValueError('Secret versions must be positive version numbers')
        result = read_json(
            f'https://secretmanager.googleapis.com/v1/projects/fleet-governance/secrets/{secret}/versions/{version}:access',
            {'Authorization': f'Bearer {token}'},
        )
        value = base64.b64decode(result['payload']['data'], validate=True).decode()
        if not value or any(char in value for char in '\r\n\0'):
            raise ValueError('A runtime secret is empty or contains unsupported line breaks')
        lines.append(f'{variable}={value}')
    directory = Path('/run/fleet')
    directory.mkdir(mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write('\n'.join(lines) + '\n')
        os.replace(temporary, directory / 'runtime.env')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    main()
