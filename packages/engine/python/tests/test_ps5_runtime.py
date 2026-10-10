import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ps5_runtime import (
    AccountStore,
    FakeBackend,
    PyRemotePlayBackend,
    RuntimeService,
    _friendly_session_error,
    _lookup_account_id_from_redirect,
    _normalize_account_id,
)


class Ps5RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = AccountStore(Path(self.tmp.name))
        self.service = RuntimeService(Path(self.tmp.name), fake=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_numeric_account_id_is_normalized_to_base64(self):
        value = _normalize_account_id("1234567890123456789")
        self.assertEqual(base64.b64decode(value), (1234567890123456789).to_bytes(8, "little"))

    def test_fake_psn_login_and_multi_account_store(self):
        first = self.service.dispatch("lookupAccountIdFromRedirect", {"redirectUrl": "https://example.invalid/?code=one"})
        second = self.service.dispatch("lookupAccountIdFromRedirect", {"redirectUrl": "https://example.invalid/?code=two"})
        self.assertNotEqual(first["accountId"], second["accountId"])
        a1 = self.service.dispatch("saveAccount", {"name": "一号", "onlineId": "PlayerOne", "accountId": first["accountId"]})
        a2 = self.service.dispatch("saveAccount", {"name": "二号", "onlineId": "PlayerTwo", "accountId": second["accountId"]})
        accounts = self.service.dispatch("listAccounts", {})["accounts"]
        self.assertEqual({a["id"] for a in accounts}, {a1["account"]["id"], a2["account"]["id"]})

    def test_pair_connect_frame_and_protocol_input(self):
        lookup = self.service.dispatch("lookupAccountIdFromRedirect", {"redirectUrl": "https://example.invalid/?code=one"})
        account = self.service.dispatch("saveAccount", {
            "name": "一号",
            "onlineId": "PlayerOne",
            "accountId": lookup["accountId"],
        })["account"]
        devices = self.service.dispatch("discover", {})["devices"]
        host = devices[0]["host"]
        self.service.dispatch("testHost", {"host": host})
        self.service.dispatch("pair", {"host": host, "accountId": account["accountId"], "pin": "12345678"})
        status = self.service.dispatch("connect", {"host": host, "accountId": account["id"]})
        self.assertTrue(status["connected"])
        frame = self.service.dispatch("getFrame", {})
        self.assertTrue(frame["frame"].startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(frame["frame"].split(",", 1)[1])[:8], b"\x89PNG\r\n\x1a\n")
        key = self.service.dispatch("sendKey", {"key": "Enter", "down": True})
        self.assertEqual(key["button"], "cross")
        button = self.service.dispatch("sendButton", {"action": "pressA", "pressed": True})
        self.assertEqual(button["button"], "cross")
        stick = self.service.dispatch("setStick", {"stick": "left", "x": 0.5, "y": -0.5})
        self.assertEqual(stick["stick"], "left")
        direction = self.service.dispatch("sendButton", {"action": "pressLU", "durationMs": 1})
        self.assertEqual(direction["button"], "stick:left")
        self.assertFalse(self.service.dispatch("disconnect", {})["connected"])

    def test_pair_requires_eight_digit_pin(self):
        account = self.service.dispatch("saveAccount", {
            "name": "一号",
            "onlineId": "PlayerOne",
            "accountId": _normalize_account_id("1234567890123456789"),
        })["account"]
        with self.assertRaisesRegex(Exception, "8 位数字"):
            self.service.dispatch("pair", {"host": "192.168.1.50", "accountId": account["accountId"], "pin": "123"})

    def test_real_backend_connect_starts_asyncio_event_loop(self):
        store = AccountStore(Path(self.tmp.name) / "real")
        account = store.save_account({
            "name": "真实账号",
            "onlineId": "PlayerOne",
            "accountId": "AAAAAAAAAAA=",
        })
        store.save_registration("192.168.1.50", account["accountId"], {
            "RegistKey": "reg-key",
            "RP-Key": "00112233445566778899aabbccddeeff",
            "host-id": "host-id",
            "host-type": "PS5",
        })
        backend = PyRemotePlayBackend(store)
        modules = {
            "ddp_get_status": lambda *_args, **_kwargs: {"host-id": "host-id", "host-type": "PS5"},
            "UserProfile": lambda *_args, **_kwargs: object(),
            "QueueReceiver": lambda **_kwargs: object(),
        }

        class ReachedAsyncio(RuntimeError):
            pass

        with mock.patch.object(backend, "_modules", return_value=modules), \
                mock.patch("ps5_runtime.asyncio.new_event_loop", side_effect=ReachedAsyncio("reached")):
            with self.assertRaisesRegex(ReachedAsyncio, "reached"):
                backend.connect("192.168.1.50", account["id"])

    def test_unknown_remote_play_error_is_actionable(self):
        message = _friendly_session_error("Unknown")
        self.assertIn("重新配对", message)
        self.assertIn("Remote Play", message)

    @mock.patch("pyremoteplay.oauth._fetch_account_info")
    @mock.patch("pyremoteplay.oauth._get_token")
    @mock.patch("pyremoteplay.oauth._parse_redirect_url")
    def test_psn_redirect_lookup_reports_each_oauth_stage(self, parse_code, get_token, fetch_account):
        parse_code.return_value = None
        with self.assertRaisesRegex(Exception, "缺少授权码"):
            _lookup_account_id_from_redirect("https://example.invalid/?code=missing")

        parse_code.return_value = "auth-code"
        get_token.return_value = None
        with self.assertRaisesRegex(Exception, "没有返回访问令牌"):
            _lookup_account_id_from_redirect("https://example.invalid/?code=missing")

        get_token.return_value = "access-token"
        fetch_account.return_value = None
        with self.assertRaisesRegex(Exception, "没有返回账号信息"):
            _lookup_account_id_from_redirect("https://example.invalid/?code=missing")

        fetch_account.return_value = {"online_id": "PlayerOne", "user_rpid": "AAAAAAAAAAA="}
        result = _lookup_account_id_from_redirect("https://example.invalid/?code=ok")
        self.assertEqual(result["onlineId"], "PlayerOne")
        self.assertEqual(result["accountId"], "AAAAAAAAAAA=")
        self.assertEqual(result["source"], "PlayStation OAuth")


if __name__ == "__main__":
    unittest.main()
