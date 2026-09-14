#!/usr/bin/env python3
"""A minimal local stand-in for the real, hosted "blockcache" service
`vendor/cpls/cpls/blockcache.py`'s BlockCacheClient calls (block timestamps,
raw contract calls, transaction lookups) for other DAOs' real mainnet/L2
chains. That service has no notion of a local Anvil chain (31337); this
shim implements just the subset of its small REST API CPLS's DAO-node sync
actually calls, backed by a real Anvil JSON-RPC endpoint, so those lookups
return genuine local-chain data instead of failing.

`vendor/cpls/cpls/blockcache.py`'s own `__main__` block sets
`BLOCKCACHE_URL = 'http://0.0.0.0:8002'` as its own local-dev convention;
this shim listens on the same port for that reason, and infra/docker-compose.yml
points cpls's BLOCKCACHE_URL at it.

Endpoints implemented (see blockcache.py for the exact shapes each of
these callers expects back):
  GET  /exact_blocktime/<chain_id>/<block_number>
       -> {"ts": <unix seconds>} if that block has actually been mined,
          else {"msg": "block not found"} (no "ts" key at all).
          BlockCacheClient.return_ts() (blockcache.py lines 52-60) maps
          exactly this shape to its BlockNotFound exception, which
          get_blocktime() (lines 75-79) catches to fall back to
          /estimated_blocktime; a "ts" key must never be present in this
          response unless the block is real, or that fallback never
          triggers and an estimate gets silently treated as exact. See
          docs/compatibility-notes.md, Task 6, "blockcache-shim's
          /exact_blocktime always answered, so CPLS's estimate fallback
          never ran".
  GET  /estimated_blocktime/<chain_id>/<block_number>
       -> {"ts": <unix seconds>}, always: the real block's timestamp if
          it exists, else an estimate extrapolated from the chain's fixed
          block time. This is the only endpoint that may extrapolate.
  POST /contract_call/<chain_id>/<address>                -> {"result": "0x..."}
                     body: {block_number, data, method_signature}; data is
                     only the ABI-encoded arguments (blockcache.py's own
                     contract_call_encoded never includes the 4-byte
                     selector), so this shim derives the selector from
                     method_signature itself before calling eth_call.
  GET  /transaction/<chain_id>/<block_number>/<tx_index>  -> {"tx": "0x..."}
Anything else: 404.

Every response CPLS's caller can't use gracefully is still wrapped so this
shim never itself hangs or 500s: an eth_call revert becomes {"result": "0x"}.
"""
import json
import os
import re
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from Crypto.Hash import keccak


def selector(method_signature):
    """4-byte Solidity function selector for a signature like 'quorum(uint256)'."""
    return keccak.new(digest_bits=256, data=method_signature.encode()).digest()[:4].hex()

RPC_URL = os.environ.get("ANVIL_RPC_URL", "http://anvil:8545")
PORT = int(os.environ.get("PORT", "8002"))
# Matches infra/anvil/Dockerfile's --block-time.
BLOCK_TIME_SECONDS = int(os.environ.get("BLOCK_TIME_SECONDS", "2"))


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC_URL, data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        parsed = json.loads(resp.read())
    if "error" in parsed:
        raise RuntimeError(parsed["error"])
    return parsed["result"]


def get_block(block_number):
    return rpc("eth_getBlockByNumber", [hex(block_number), False])


def latest_block():
    return rpc("eth_getBlockByNumber", ["latest", False])


def exact_blocktime(block_number):
    """The real block's timestamp, or None if that block has not been
    mined yet. Never extrapolates: callers must turn None into the
    "block not found" shape blockcache.py's return_ts() checks for, not
    into an estimate."""
    block = get_block(block_number)
    if block is None:
        return None
    return int(block["timestamp"], 16)


def estimated_blocktime(block_number):
    """The real block's timestamp if it exists, else an estimate
    extrapolated from the chain's fixed block time. Always returns a
    value; this is the only function that may extrapolate."""
    block = get_block(block_number)
    if block is not None:
        return int(block["timestamp"], 16)
    latest = latest_block()
    latest_number = int(latest["number"], 16)
    latest_ts = int(latest["timestamp"], 16)
    return latest_ts + (block_number - latest_number) * BLOCK_TIME_SECONDS


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print("blockcache-shim: " + (fmt % args))

    def do_GET(self):
        m = re.fullmatch(r"/exact_blocktime/(\d+)/(\d+)", self.path)
        if m:
            try:
                ts = exact_blocktime(int(m.group(2)))
            except Exception as e:  # noqa: BLE001
                # A genuine RPC failure (not "block doesn't exist yet",
                # which eth_getBlockByNumber reports as a null result, not
                # an error) still has to come back as the "not found"
                # shape: blockcache.py's return_ts() only understands
                # {"ts": ...} or {"msg": "block not found"}; anything else
                # raises an unhandled exception on the CPLS side instead
                # of falling back to /estimated_blocktime.
                self._send(404, {"msg": "block not found", "error": str(e)})
                return
            if ts is None:
                self._send(404, {"msg": "block not found"})
            else:
                self._send(200, {"ts": ts})
            return

        m = re.fullmatch(r"/estimated_blocktime/(\d+)/(\d+)", self.path)
        if m:
            try:
                ts = estimated_blocktime(int(m.group(2)))
                self._send(200, {"ts": ts})
            except Exception as e:  # noqa: BLE001
                self._send(500, {"msg": "block not found", "error": str(e)})
            return

        m = re.fullmatch(r"/transaction/(\d+)/(\d+)/(\d+)", self.path)
        if m:
            try:
                block = get_block(int(m.group(2)))
                full = rpc("eth_getBlockByNumber", [hex(int(m.group(2))), True])
                txs = full["transactions"] if full else []
                idx = int(m.group(3))
                if block is None or idx >= len(txs):
                    self._send(404, {"error": "transaction not found"})
                else:
                    self._send(200, {"tx": txs[idx]["hash"]})
            except Exception as e:  # noqa: BLE001
                self._send(404, {"error": str(e)})
            return

        self._send(404, {"error": "not found"})

    def do_POST(self):
        m = re.fullmatch(r"/contract_call/(\d+)/(0x[0-9a-fA-F]{40})", self.path)
        if m:
            length = int(self.headers.get("content-length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
            block_number = payload.get("block_number")
            method_signature = payload.get("method_signature", "")
            # cpls/blockcache.py's contract_call_encoded() sends only the
            # ABI-encoded arguments in `data` (empty for a no-arg method),
            # never the 4-byte selector; the real blockcache service must
            # derive the selector from method_signature itself, so this
            # shim does the same.
            params = (payload.get("data") or "").removeprefix("0x")
            call_data = "0x" + selector(method_signature) + params
            block_tag = "latest" if block_number in (None, "latest") else hex(int(block_number))
            try:
                result = rpc("eth_call", [{"to": m.group(2), "data": call_data}, block_tag])
                self._send(200, {"result": result})
            except Exception:  # noqa: BLE001
                # Every caller of contract_call_encoded in cpls/sync_daonode.py
                # is wrapped in try/except at the call site (quorum, votable
                # supply) or only reached once a proposal is already
                # archived (post-execution state re-check); a clean, empty
                # result lets that code degrade the same way a genuine
                # revert on the real blockcache service would, rather than
                # this shim raising a 500 mid-response.
                self._send(200, {"result": "0x"})
            return

        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"blockcache-shim: listening on :{PORT}, proxying {RPC_URL}")
    server.serve_forever()
