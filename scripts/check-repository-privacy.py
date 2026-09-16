#!/usr/bin/env python3
"""Check tracked content without printing matched personal data or credentials."""
import re
import subprocess
import sys


EMAIL = re.compile(rb'[A-Za-z0-9._%+\-]+@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})')
ALLOWED_DOMAINS = {b'example.com', b'example.org', b'example.invalid', b'users.noreply.github.com'}
PUBLIC_SERVICE_IDENTITIES = {b'git@github.com', b'noreply@anthropic.com'}
PATTERNS = [
    ("personal home directory", re.compile(rb'/Users/[A-Za-z0-9_.-]+')),
    ("provider credential", re.compile(rb'sk-or-v1-[A-Za-z0-9]{30,}|alch_[A-Za-z0-9_-]{15,}')),
    ("private key", re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')),
    ("MCP credential", re.compile(rb'fleet_mcp_[A-Za-z0-9_-]{43}')),
    ("private assistant session", re.compile(rb'https://claude\.ai/code/session_[A-Za-z0-9]+')),
]


def main():
    failures = []
    records = subprocess.check_output(['git', 'ls-files', '-s', '-z']).split(b'\0')
    objects = subprocess.Popen(['git', 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    for record in records:
        if not record:
            continue
        metadata, filename = record.split(b'\t', 1)
        mode, oid, stage = metadata.split()
        if mode == b'160000':
            continue  # Third-party repositories are reviewed separately.
        objects.stdin.write(oid + b'\n')
        objects.stdin.flush()
        header = objects.stdout.readline().split()
        data = objects.stdout.read(int(header[-1]))
        objects.stdout.read(1)
        if b'\0' in data:
            continue
        name = filename.decode()
        for match in EMAIL.finditer(data):
            domain = match.group(1).lower()
            if match.group(0) not in PUBLIC_SERVICE_IDENTITIES and domain not in ALLOWED_DOMAINS and not domain.endswith((b'.gserviceaccount.com', b'.example.com', b'.example')):
                failures.append((name, data[:match.start()].count(b'\n') + 1, 'personal email'))
        for label, pattern in PATTERNS:
            for match in pattern.finditer(data):
                failures.append((name, data[:match.start()].count(b'\n') + 1, label))
    objects.stdin.close()
    objects.wait()
    for name, line, label in failures:
        print(f'{name}:{line}: {label} must remain in private configuration', file=sys.stderr)
    if failures:
        return 1
    print('Tracked content contains no personal emails, home directories or recognised live credentials.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
