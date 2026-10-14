import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


RUNTIME = Path(__file__).resolve().parents[1] / "ps5_runtime.py"


class Ps5JsonlTests(unittest.TestCase):
    def test_json_lines_server_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, NOBOWO_PS5_FAKE="1")
            requests = [
                {"id": 1, "method": "status", "params": {}},
                {"id": 2, "method": "lookupAccountIdFromRedirect", "params": {"redirectUrl": "https://example.invalid/?code=one"}},
                {"id": 3, "method": "saveAccount", "params": {"name": "一号", "onlineId": "PlayerOne", "accountId": "AAAAAAAAAAA="}},
                {"id": 4, "method": "discover", "params": {}},
                {"id": 5, "method": "pair", "params": {"host": "192.168.1.50", "accountId": "AAAAAAAAAAA=", "pin": "12345678"}},
                {"id": 6, "method": "connect", "params": {"host": "192.168.1.50", "accountId": "AAAAAAAAAAA="}},
                {"id": 7, "method": "getFrame", "params": {}},
                {"id": 8, "method": "sendButton", "params": {"action": "pressCross", "pressed": True}},
                {"id": 9, "method": "disconnect", "params": {}},
            ]
            payload = "".join(json.dumps(item) + "\n" for item in requests)
            proc = subprocess.run(
                [sys.executable, str(RUNTIME), "serve", tmp],
                input=payload,
                text=True,
                capture_output=True,
                env=env,
                timeout=10,
                check=True,
            )
            responses = {item["id"]: item for item in map(json.loads, proc.stdout.splitlines())}
            self.assertTrue(responses[1]["ok"])
            self.assertIn("accountId", responses[2]["result"])
            self.assertEqual(len(responses[4]["result"]["devices"]), 2)
            self.assertTrue(responses[6]["result"]["connected"])
            self.assertTrue(responses[7]["result"]["frame"].startswith("data:image/"))
            self.assertEqual(responses[8]["result"]["button"], "cross")
            self.assertFalse(responses[9]["result"]["connected"])


if __name__ == "__main__":
    unittest.main()
