import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('cdp_import', Path(__file__).parents[1] / 'import-cdp-secrets.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.values = module.credentials_from_json(json.dumps({
            'api_key_id': '00000000-0000-4000-8000-000000000001',
            'api_key_secret': base64.b64encode(bytes(range(64))).decode(),
        }))
        self.stored = {}
        self.writes = []

    def cloud(self, *args, value=None):
        operation = args[2]
        if operation == 'list':
            name = args[3]
            return json.dumps([{'name': f'{name}/versions/1', 'state': 'ENABLED'}] if name in self.stored else [])
        if operation == 'access':
            return self.stored[args[4].split('=', 1)[1]]
        if operation == 'add':
            name = args[3]
            self.writes.append(name)
            self.stored[name] = value
            return json.dumps({'name': f'{name}/versions/1'})
        self.fail('Unexpected cloud operation')

    def test_import_and_rerun_preserve_versions(self):
        with patch.object(module, 'gcloud', side_effect=self.cloud):
            expected = {name: '1' for name in self.values}
            self.assertEqual(module.import_credentials(self.values), expected)
            self.assertEqual(module.import_credentials(self.values), expected)
        self.assertEqual(self.stored, self.values)
        self.assertEqual(len(self.writes), 2)

    def test_mismatch_is_detected_before_any_write(self):
        # The first secret is missing; a mismatch in the second must prevent both writes.
        self.stored['fleet-cdp-api-key-secret'] = 'existing-value'
        with patch.object(module, 'gcloud', side_effect=self.cloud):
            with self.assertRaisesRegex(module.ImportFailure, 'explicit rotation'):
                module.import_credentials(self.values)
        self.assertEqual(self.writes, [])

    def test_retry_completes_a_partial_import(self):
        self.stored['fleet-cdp-api-key-id'] = self.values['fleet-cdp-api-key-id']
        with patch.object(module, 'gcloud', side_effect=self.cloud):
            module.import_credentials(self.values)
        self.assertEqual(self.writes, ['fleet-cdp-api-key-secret'])

    def test_disabled_version_stops_import(self):
        with patch.object(module, 'gcloud', return_value=json.dumps([{'name': 'secret/versions/1', 'state': 'DISABLED'}])):
            with self.assertRaisesRegex(module.ImportFailure, 'not enabled'):
                module.import_credentials(self.values)

    def test_bad_readback_stops_import(self):
        def cloud(*args, **kwargs):
            result = self.cloud(*args, **kwargs)
            return 'wrong-value' if args[2] == 'access' else result
        with patch.object(module, 'gcloud', side_effect=cloud):
            with self.assertRaisesRegex(module.ImportFailure, 'verification'):
                module.import_credentials(self.values)

    def test_cli_error_does_not_disclose_output_or_input(self):
        result = subprocess.CompletedProcess([], 1, 'sensitive-stdout', 'sensitive-stderr')
        with patch.object(module.subprocess, 'run', return_value=result):
            with self.assertRaises(module.ImportFailure) as caught:
                module.gcloud('secrets', 'versions', 'add', 'name', value='sensitive-input')
        self.assertNotIn('sensitive', str(caught.exception))

    def test_invalid_json_and_extra_fields_are_rejected(self):
        for raw in ('', 'sensitive-malformed-json', '{}', '{"unexpected":"sensitive"}', '[]'):
            with self.subTest(raw=raw), self.assertRaises(module.ImportFailure) as caught:
                module.credentials_from_json(raw)
            self.assertNotIn('sensitive', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
