#!/usr/bin/env python3
"""One-time secret input. Resource creation and deployment belong in GitHub Actions."""
import getpass
import json
import secrets
import subprocess
import sys


PROJECT = 'fleet-governance'
NAMES = ('fleet-openrouter-api-key', 'fleet-postgres-password', 'fleet-jwt-secret')


def gcloud(*arguments, value=None):
    result = subprocess.run(
        ['gcloud', *arguments, f'--project={PROJECT}', '--quiet'],
        input=value, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        # Values must never appear in diagnostics, even if a future CLI echoes input.
        raise RuntimeError(f'gcloud failed while handling {arguments[0:3]}; exit {result.returncode}')
    return result.stdout


def main():
    missing = []
    for name in NAMES:
        versions = json.loads(gcloud('secrets', 'versions', 'list', f'--secret={name}', '--format=json'))
        if versions:
            print(f'{name}: existing versions preserved')
        else:
            missing.append(name)
    if not missing:
        return
    values = {}
    if 'fleet-openrouter-api-key' in missing:
        if not sys.stdin.isatty():
            raise RuntimeError('Use an interactive terminal so the OpenRouter key stays hidden')
        key = getpass.getpass('OpenRouter key (hidden): ').strip()
        if not key.startswith('sk-or-') or any(char.isspace() for char in key):
            raise ValueError('Expected an OpenRouter key without whitespace')
        values['fleet-openrouter-api-key'] = key
    for name in missing:
        value = values.get(name) or secrets.token_urlsafe(48)
        result = json.loads(gcloud(
            'secrets', 'versions', 'add', name, '--data-file=-', '--format=json', value=value,
        ))
        print(f"{name}: created version {result['name'].rsplit('/', 1)[-1]}")


if __name__ == '__main__':
    main()
