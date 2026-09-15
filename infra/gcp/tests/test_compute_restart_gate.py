import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location('compute_restart_gate', Path(__file__).parents[1] / 'assert-compute-unarmed.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ComputeRestartGateTests(unittest.TestCase):
    def invoke(self, response):
        with patch.object(gate.subprocess, 'run', return_value=SimpleNamespace(stdout='test-token')):
            with patch.object(gate.urllib.request, 'urlopen', side_effect=response if isinstance(response, Exception) else None,
                              return_value=response):
                gate.main()

    def test_missing_allocation_permits_normal_start(self):
        self.invoke(HTTPError('redacted', 404, '', {}, None))

    def test_existing_allocation_requires_explicit_recovery(self):
        with self.assertRaisesRegex(RuntimeError, 'operator recovery'):
            self.invoke(MagicMock())

    def test_auth_server_and_network_errors_do_not_look_like_missing_policy(self):
        for failure in [HTTPError('redacted', code, '', {}, None) for code in [401, 403, 429, 500]] + [URLError('private diagnostic')]:
            with self.subTest(failure=type(failure).__name__):
                with self.assertRaisesRegex(RuntimeError, 'restart denied') as context:
                    self.invoke(failure)
                self.assertNotIn('private diagnostic', str(context.exception))
