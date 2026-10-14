import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
ENGINE_ROOT = ROOT / "packages" / "engine" / "python"
sys.path.insert(0, str(ENGINE_ROOT))

import vision_runtime


class YoloStreamRuntimeTests(unittest.TestCase):
    def test_stream_loads_model_once_and_reuses_it_for_multiple_frames(self):
        requests = io.StringIO(
            "\n".join([
                json.dumps({"id": 1, "frameDataUrl": "data:image/jpeg;base64,YQ=="}),
                json.dumps({"id": 2, "frameDataUrl": "data:image/jpeg;base64,Yg=="}),
                json.dumps({"command": "stop"}),
            ]) + "\n"
        )
        output = io.StringIO()

        runtime = {
            "deviceName": "cpu",
            "cpuThreads": 8,
            "mpsAvailable": False,
            "torchVersion": "test",
        }
        with patch.object(vision_runtime, "_load_yolo_runtime", return_value=runtime) as load_model, \
                patch.object(vision_runtime, "_read_yolo_image", side_effect=lambda _runtime, request: request["id"]) as read_image, \
                patch.object(
                    vision_runtime,
                    "_detect_yolo_image",
                    side_effect=lambda _runtime, frame: [{"label": "指示器", "confidence": 80, "box": [frame, 0, 1, 1]}],
                ) as detect_image, \
                patch.object(sys, "stdin", requests), \
                redirect_stdout(output):
            result = vision_runtime.run_yolo_stream({"modelPath": "model.pth"})

        events = [json.loads(line) for line in output.getvalue().splitlines() if line.startswith("{")]
        self.assertEqual(result, 0)
        self.assertEqual(load_model.call_count, 1)
        self.assertEqual(read_image.call_count, 2)
        self.assertEqual(detect_image.call_count, 2)
        self.assertEqual(events[0]["t"], "ready")
        self.assertEqual([event.get("id") for event in events[1:3]], [1, 2])
        self.assertTrue(all(event["ok"] for event in events[1:3]))
        self.assertEqual(events[0]["device"], "cpu")
        self.assertEqual(events[0]["cpuThreads"], 8)
        self.assertFalse(events[0]["mpsAvailable"])
        self.assertEqual(events[-1]["t"], "stopped")


if __name__ == "__main__":
    unittest.main()
