#!/usr/bin/env python3
"""Verify the bundled snapshots and compare saved captures, without an RPC or model key.

This checks integrity and consistency of the supplied evidence. Run execution-demo to reproduce
the experiment independently; this script does not establish a public-chain trust anchor.
"""
import gzip
import hashlib
import json
from pathlib import Path


def rows(values):
    return sorted(json.dumps(value, sort_keys=True, separators=(",", ":")) for value in values)


def verify(directory):
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        expected, name = line.split("  ", 1)
        path = directory / name
        if path.parent != directory or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"{directory.name}: checksum mismatch: {name}")
    if not (directory / "record.json.gz").exists() or not (directory / "chain-recaptured.json.gz").exists():
        print(f"{directory.name}: bundled checksums match; raw captures are generated locally")
        return
    record = json.loads(gzip.decompress((directory / "record.json.gz").read_bytes()))
    captured = json.loads(gzip.decompress((directory / "chain-recaptured.json.gz").read_bytes()))
    for key in ("events", "votes", "fees"):
        if rows(record[key]) != rows(captured[key]):
            raise ValueError(f"{directory.name}: {key} differ")
    for key in ("events", "artifacts"):
        if rows(record.get("execution", {}).get(key, [])) != rows(captured.get("execution", {}).get(key, [])):
            raise ValueError(f"{directory.name}: resource {key} differ")
    print(f"{directory.name}: checksums and captures match; {len(record['votes'])} ballots")


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1] / "docs" / "evidence"
    directories = sorted(path.parent for path in root.glob("*/SHA256SUMS"))
    if not directories:
        raise ValueError("No bundled evidence found")
    for directory in directories:
        verify(directory)
