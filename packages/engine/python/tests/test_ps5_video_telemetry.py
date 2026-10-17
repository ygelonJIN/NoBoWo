import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ps5_runtime import AccountStore, PyRemotePlayBackend, RuntimeService, VideoTelemetry


class Ps5VideoTelemetryTests(unittest.TestCase):
    def test_reports_real_frame_rate_count_and_latest_frame_latency(self):
        telemetry = VideoTelemetry(window_seconds=2.0)
        telemetry.record(100.00, 1280, 720, 1_000)
        telemetry.record(100.10, 1280, 720, 1_100)
        telemetry.record(100.20, 1280, 720, 1_200)

        snapshot = telemetry.snapshot(now=100.25)
        self.assertEqual(snapshot["frameCount"], 3)
        self.assertAlmostEqual(snapshot["fps"], 10.0, places=1)
        self.assertEqual(snapshot["latencyMs"], 50)
        self.assertEqual(snapshot["timestamp"], 1_200)
        self.assertEqual(snapshot["width"], 1280)
        self.assertEqual(snapshot["height"], 720)

    def test_old_arrival_samples_leave_the_fps_window_but_keep_total_count(self):
        telemetry = VideoTelemetry(window_seconds=1.0)
        telemetry.record(10.0, 640, 360)
        telemetry.record(10.1, 640, 360)
        snapshot = telemetry.snapshot(now=12.0)
        self.assertEqual(snapshot["frameCount"], 2)
        self.assertEqual(snapshot["fps"], 0.0)
        self.assertEqual(snapshot["latencyMs"], 1900)

    def test_queue_receiver_instrumentation_records_each_decoded_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = PyRemotePlayBackend(AccountStore(Path(tmp)))
            calls = []

            class Receiver:
                def handle_video(self, frame):
                    calls.append(frame)

            receiver = backend._instrument_receiver(Receiver())
            receiver.handle_video(SimpleNamespace(width=1920, height=1080))
            receiver.handle_video(SimpleNamespace(width=1920, height=1080))

            snapshot = backend._video_telemetry.snapshot()
            self.assertEqual(len(calls), 2)
            self.assertEqual(snapshot["frameCount"], 2)
            self.assertEqual(snapshot["width"], 1920)
            self.assertEqual(snapshot["height"], 1080)

    def test_frame_and_status_expose_trusted_telemetry_protocol_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            service = RuntimeService(Path(tmp), fake=True)
            service.backend.connected = True
            status = service.dispatch("status", {})
            frame = service.dispatch("getFrame", {})
            self.assertEqual(status["telemetryVersion"], 2)
            self.assertEqual(frame["telemetryVersion"], 2)
            self.assertGreaterEqual(frame["frameCount"], 1)


if __name__ == "__main__":
    unittest.main()
