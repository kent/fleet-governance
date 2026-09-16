#!/usr/bin/env python3
"""Import the private five-person allowlist without printing identities or values."""
import json
import os
import re
import subprocess


def validated_emails(raw):
    try:
        emails = json.loads(raw)
        if (not isinstance(emails, list) or len(emails) != 5
                or any(not isinstance(email, str)
                       or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email)
                       or email.endswith('.gserviceaccount.com') for email in emails)
                or len(set(emails)) != 5):
            raise ValueError()
        return emails
    except (ValueError, TypeError):
        raise ValueError('A private allowlist of five distinct human identities is required') from None


def run(*args, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('Private operator configuration failed; provider output withheld')
    return result.stdout


def main():
    emails = validated_emails(os.environ.get('FLEET_OPERATOR_EMAILS_JSON', ''))
    # Mask each identity separately, even if a later tool prints part of the list.
    for email in emails:
        print('::add-mask::' + email, flush=True)
    versions = json.loads(run('gcloud', 'secrets', 'versions', 'list', 'fleet-operator-emails', '--format=json'))
    if versions:
        existing = validated_emails(run('gcloud', 'secrets', 'versions', 'access', '1', '--secret=fleet-operator-emails'))
        if set(existing) != set(emails):
            raise RuntimeError('Existing pinned operator configuration differs; explicit rotation is required')
    else:
        run('gcloud', 'secrets', 'versions', 'add', 'fleet-operator-emails', '--data-file=-', input=json.dumps(emails, separators=(',', ':')))
    for service in ['fleet-governance-control', 'fleet-governance-mcp']:
        run('gcloud', 'run', 'services', 'update', service, '--region=us-central1',
            '--update-secrets=FLEET_OPERATOR_EMAILS_JSON=fleet-operator-emails:1', '--quiet')
    run('gcloud', 'run', 'jobs', 'update', 'fleet-simulation', '--region=us-central1',
        '--update-secrets=FLEET_OPERATOR_EMAILS_JSON=fleet-operator-emails:1', '--quiet')
    print('Private operator configuration installed for both services and the preparation job. No experiment launched.')


if __name__ == '__main__':
    main()
