#!/usr/bin/env python3
"""Import a temporary encrypted GitHub secret into existing GCP containers."""
import argparse
import base64
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys


PROJECT = 'fleet-governance'
FIELDS = {
    'api_key_id': 'fleet-cdp-api-key-id',
    'api_key_secret': 'fleet-cdp-api-key-secret',
}
RPC_FIELDS = {
    'rpc_http_url': 'fleet-base-sepolia-rpc-url',
    'rpc_ws_url': 'fleet-base-sepolia-ws-url',
}


class ImportFailure(Exception):
    """An error whose message never contains credential values or CLI output."""


def credentials_from_json(raw, kind='cdp'):
    fields = RPC_FIELDS if kind == 'rpc' else FIELDS
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        raise ImportFailure('Missing or invalid bootstrap JSON.') from None
    if not isinstance(data, dict) or set(data) != set(fields):
        raise ImportFailure('Unexpected bootstrap credential fields.')
    if any(not isinstance(value, str) for value in data.values()):
        raise ImportFailure('Both credential fields must be strings.')
    if kind == 'rpc':
        http = re.fullmatch(r'https://base-sepolia\.g\.alchemy\.com/v2/([A-Za-z0-9_-]{10,200})', data['rpc_http_url'])
        ws = re.fullmatch(r'wss://base-sepolia\.g\.alchemy\.com/v2/([A-Za-z0-9_-]{10,200})', data['rpc_ws_url'])
        if not http or not ws or not hmac.compare_digest(http[1], ws[1]):
            raise ImportFailure('Expected matching Alchemy Base Sepolia HTTP and WSS endpoints.')
        return {secret: data[field] for field, secret in fields.items()}
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', data['api_key_id']):
        raise ImportFailure('Expected a CDP API key UUID.')
    try:
        key = base64.b64decode(data['api_key_secret'], validate=True)
    except ValueError:
        raise ImportFailure('Expected a base64 Ed25519 secret.') from None
    if len(key) != 64:
        raise ImportFailure('Expected a 64-byte Ed25519 secret.')
    return {secret: data[field] for field, secret in FIELDS.items()}


def gcloud(*arguments, value=None):
    result = subprocess.run(
        ['gcloud', *arguments, f'--project={PROJECT}', '--quiet'],
        input=value, text=True, capture_output=True, timeout=120,
    )
    if result.returncode:
        raise ImportFailure(f'gcloud {arguments[0]} {arguments[1]} failed; output withheld.')
    return result.stdout


def read_version(name, version):
    return gcloud('secrets', 'versions', 'access', version, f'--secret={name}')


def import_credentials(values):
    selected = {}
    # Check both credentials before writing either. Never silently rotate a pair.
    for name, value in values.items():
        versions = json.loads(gcloud('secrets', 'versions', 'list', name, '--format=json'))
        if not versions:
            continue
        newest = max(versions, key=lambda item: int(item['name'].rsplit('/', 1)[-1]))
        if newest['state'] != 'ENABLED':
            raise ImportFailure(f'{name}: newest version is not enabled; import stopped.')
        version = newest['name'].rsplit('/', 1)[-1]
        if not hmac.compare_digest(read_version(name, version), value):
            raise ImportFailure(f'{name}: existing value differs; explicit rotation is required.')
        selected[name] = version
    for name, value in values.items():
        if name not in selected:
            created = json.loads(gcloud(
                'secrets', 'versions', 'add', name, '--data-file=-', '--format=json', value=value,
            ))
            selected[name] = created['name'].rsplit('/', 1)[-1]
        if not hmac.compare_digest(read_version(name, selected[name]), value):
            raise ImportFailure(f'{name}: stored value did not pass verification.')
    return selected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', choices=('cdp', 'rpc'), required=True)
    kind = parser.parse_args().kind
    # Remove the transport secret before spawning any child process.
    values = credentials_from_json(os.environ.pop(f'{kind.upper()}_BOOTSTRAP_CREDENTIALS', ''), kind)
    selected = import_credentials(values)
    lines = [f'{name}: verified enabled version {version}' for name, version in selected.items()]
    print('\n'.join(lines))
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with Path(summary).open('a') as stream:
            stream.write(f'\n{kind.upper()} credentials imported and read back successfully.\n\n')
            stream.write('\n'.join(f'- {line}' for line in lines) + '\n')


if __name__ == '__main__':
    try:
        main()
    except ImportFailure as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # Do not print unexpected response bodies, subprocess arguments or input.
        print('Secret import failed unexpectedly; diagnostic values withheld.', file=sys.stderr)
        sys.exit(1)
