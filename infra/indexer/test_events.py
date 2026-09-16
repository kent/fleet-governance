import unittest
from events import GOVERNOR, START, canonical_action, matches, normalize

class EventsTest(unittest.TestCase):
    def row(self, **extra):
        return {'_gs_op':'i','address':GOVERNOR,'block_number':START,'transaction_index':0,
                'log_index':3,'block_hash':'0x'+'11'*32,'transaction_hash':'0x'+'22'*32,
                'topics':'0x'+'33'*32,'data':'0x', **extra}

    def test_duplicate_identity_and_delete_identity_match(self):
        first = normalize(self.row())
        duplicate = normalize(self.row(_gs_op='u'))
        deletion = normalize(self.row(_gs_op='d'))
        self.assertEqual(first[0], duplicate[0])
        self.assertEqual(first[0], deletion[0])
        self.assertTrue(deletion[1])

    def test_wrong_contract_and_unknown_operation_rejected(self):
        for row in [self.row(address='0x'+'44'*20), self.row(_gs_op='x'), self.row(block_number=1)]:
            with self.assertRaises(ValueError): normalize(row)

    def test_reorg_replay_cannot_restore_orphan(self):
        self.assertEqual(canonical_action(False, 'old', 'new'), 'ignore')
        self.assertEqual(canonical_action(True, 'old', 'new'), 'delete')
        self.assertEqual(canonical_action(True, 'old', 'old'), 'retry')
        self.assertEqual(canonical_action(False, 'new', 'new'), 'upsert')

    def test_rpc_topics_and_address_filter(self):
        log = normalize(self.row())[2]
        self.assertTrue(matches(log, [GOVERNOR], [[log['topics'][0]]]))
        self.assertFalse(matches(log, [GOVERNOR], ['0x'+'44'*32]))
        self.assertFalse(matches(log, [GOVERNOR], [None, '0x'+'44'*32]))

if __name__ == '__main__': unittest.main()
