"""Strict normalization of the fixed Fleet Goldsky log feed."""
import re

GOVERNOR = '0x9594876c90a14888c6734231a731caba4c0d0781'
TOKEN = '0xc70af42f2e4fc5551d7046e955c9aea6c16eeb8f'
START = 46858912

def hex_value(value, size=None):
    if not isinstance(value, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', value):
        raise ValueError('Invalid hex data')
    if size is not None and len(value) != 2 + size * 2:
        raise ValueError('Wrong hex length')
    return value.lower()

def normalize(row):
    if not isinstance(row, dict) or row.get('_gs_op') not in ('i', 'c', 'u', 'd'):
        raise ValueError('Missing or unsupported change operation')
    address = hex_value(row['address'], 20)
    if address not in (GOVERNOR, TOKEN):
        raise ValueError('Unexpected contract')
    numbers = [int(row[name]) for name in ('block_number', 'transaction_index', 'log_index')]
    if numbers[0] < START or any(n < 0 for n in numbers):
        raise ValueError('Invalid event position')
    topics = row['topics'].split(',') if isinstance(row['topics'], str) else row['topics']
    if not isinstance(topics, list) or not 1 <= len(topics) <= 4:
        raise ValueError('Invalid event topics')
    log = {'address': address, 'blockNumber': hex(numbers[0]), 'transactionIndex': hex(numbers[1]),
           'logIndex': hex(numbers[2]), 'blockHash': hex_value(row['block_hash'], 32),
           'transactionHash': hex_value(row['transaction_hash'], 32),
           'topics': [hex_value(topic, 32) for topic in topics], 'data': hex_value(row['data']), 'removed': False}
    # Transaction/log identity is stable across duplicate deliveries and replays.
    return log['transactionHash'] + ':' + str(numbers[2]), row['_gs_op'] == 'd', log

def matches(log, addresses, topics):
    if addresses and log['address'] not in addresses:
        return False
    for index, expected in enumerate(topics):
        if expected is None:
            continue
        options = expected if isinstance(expected, list) else [expected]
        if index >= len(log['topics']) or log['topics'][index] not in [t.lower() for t in options]:
            return False
    return True

def canonical_action(deleted, log_hash, canonical_hash):
    if deleted:
        # A lagging RPC must not cause us to acknowledge a deletion prematurely.
        return 'retry' if canonical_hash == log_hash else 'delete'
    return 'upsert' if canonical_hash == log_hash else 'ignore'
