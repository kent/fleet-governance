"""Exercise the actual Feed class without starting Sanic or loading deployment secrets."""
import ast
import asyncio
from collections import defaultdict
from copy import deepcopy
from pathlib import Path
import random
import time
from types import SimpleNamespace


def test_archive_receipts_are_not_dispatched_again_by_overlapping_polling():
    tree = ast.parse(Path('app/server.py').read_text())
    feed_class = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Feed')
    namespace = dict(defaultdict=defaultdict, asyncio=asyncio, Profiler=lambda: None,
                     time=time, random=random, deepcopy=deepcopy,
                     logr=SimpleNamespace(info=lambda *_: None),
                     CAPTURE_CLIENT_OUTPUTS_TO_DISK=False, PROFILE_ARCHIVE_CLIENT=False,
                     CAPTURE_WS_CLIENT_OUTPUTS=False)
    exec(compile(ast.Module(body=[feed_class], type_ignores=[]), 'app/server.py', 'exec'), namespace)
    receipt = {'block_number': 100, 'transaction_index': 2, 'log_index': 3,
               'signal': '84532.token.Transfer(address,address,uint256)'}
    fresh = {**receipt, 'block_number': 101}

    class Archive:
        timeliness = 'archive'
        def get_fallback_block(self): return 0
        def read(self, after):
            yield dict(receipt), receipt['signal'], True

    class Poll:
        timeliness = 'polling'
        async def read(self):
            for row in [receipt, fresh]: yield dict(row)

    class Clients:
        def __iter__(self): return iter([(0, Archive())])
        async def get_async_iterator(self): yield 1, Poll()

    feed = namespace['Feed']()
    feed.cs = Clients()
    assert len(list(feed.read_archive())) == 1

    async def collect():
        first = [event async for event in feed.realtime_async_read(1)]
        second = [event async for event in feed.realtime_async_read(1)]
        return first, second

    first, second = asyncio.run(collect())
    assert [event['block_number'] for event in first] == [101]
    assert second == []
