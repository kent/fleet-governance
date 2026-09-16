import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('operator_config', Path(__file__).parents[1] / 'configure-operators.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OperatorConfigTests(unittest.TestCase):
    def test_exact_private_allowlist(self):
        emails = [f'operator{i}@example.com' for i in range(5)]
        self.assertEqual(module.validated_emails(json.dumps(emails)), emails)

    def test_rejects_invalid_data_without_echoing_it(self):
        for value in ['', 'private-value', 'null', '{}', '[]', json.dumps(['same@example.com'] * 5),
                      json.dumps(['one@project.iam.gserviceaccount.com'] + [f'operator{i}@example.com' for i in range(4)])]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, '^A private allowlist of five distinct human identities is required$'):
                module.validated_emails(value)
