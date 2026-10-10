import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pyremoteplay.receiver import AVReceiver
from pyremoteplay.session import _format_auth_request

from ps5_runtime import AccountStore, PyRemotePlayBackend, _registration_from_result


class PyRemotePlayContractTests(unittest.TestCase):
    def test_remote_play_request_headers_remove_parser_incompatible_defaults(self):
        request = _format_auth_request(
            "/sie/ps5/rp/sess/init",
            {"Host": "192.168.1.1:9295", "Rp-Version": "1.0"},
        )
        self.assertEqual(
            request,
            b"GET /sie/ps5/rp/sess/init HTTP/1.1\r\n"
            b"Host: 192.168.1.1:9295\r\n"
            b"Rp-Version: 1.0\r\n\r\n",
        )

    def test_audio_resampler_accepts_current_pyav_layout_api(self):
        resampler = AVReceiver.audio_resampler()
        self.assertIsNotNone(resampler)

    def test_real_pyremoteplay_profile_session_and_controller_contracts(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = PyRemotePlayBackend(AccountStore(Path(tmp)))
            modules = backend._modules()
            registration = _registration_from_result(
                {"PS5-RegistKey": "11", "PS5-RP-Key": "22"},
                {"host-id": "host-id", "host-type": "PS5"},
            )
            profile = modules["UserProfile"]("Test", {
                "id": "AAAAAAAAAAA=",
                "hosts": {"host-id": {"type": "PS5", "data": registration}},
            })
            receiver = modules["QueueReceiver"](max_frames=2, max_video_frames=1, max_audio_frames=0)
            session = modules["Session"](
                "127.0.0.1",
                profile,
                receiver=receiver,
                resolution="720p",
                fps=60,
                quality="high",
            )
            controller = modules["Controller"]()
            controller.connect(session)
            self.assertEqual(session.resolution.name, "RESOLUTION_720P")
            self.assertEqual(session.fps.value, 60)
            self.assertIs(session.receiver, receiver)
            self.assertFalse(controller.ready)


if __name__ == "__main__":
    unittest.main()
