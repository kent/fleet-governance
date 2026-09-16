#!/usr/bin/env python3
"""CI restart gate. Only a missing active object means unarmed; auth/network failures deny."""
import subprocess
import urllib.error
import urllib.request


def main():
    token = subprocess.run(
        ['gcloud', 'auth', 'print-access-token'], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    ).stdout.strip()
    for name in ['active.json', 'simulation-queue.json', 'batches%2Factive.json']:
        request = urllib.request.Request(
            f'https://storage.googleapis.com/storage/v1/b/fleet-governance-control-449245570324/o/{name}',
            headers={'Authorization': f'Bearer {token}'},
        )
        try:
            with urllib.request.urlopen(request, timeout=20):
                pass
        except urllib.error.HTTPError as error:
            if error.code == 404:
                continue
            raise RuntimeError('Compute allocation authority could not be read; restart denied.') from None
        except Exception:
            raise RuntimeError('Compute allocation authority could not be verified; restart denied.') from None
        raise RuntimeError('A compute allocation or simulation is armed. Explicit operator recovery is required before restart or deployment.')



if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Compute authority verification failed; restart denied.')
        raise SystemExit(1)
