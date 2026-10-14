import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
YOLOX_ROOT = ROOT / "third_party" / "YOLOX"
sys.path.insert(0, str(YOLOX_ROOT))

import torch

from yolox.models.losses import IOUloss
from yolox.models.yolo_head import YOLOXHead
from yolox.utils.boxes import bboxes_iou


class YoloMpsCompatibilityTests(unittest.TestCase):
    def devices(self):
        devices = ["cpu"]
        if hasattr(torch, "mps") and torch.backends.mps.is_available():
            devices.append("mps")
        return devices

    def test_grid_and_decode_keep_reference_dtype_and_device(self):
        for device in self.devices():
            with self.subTest(device=device):
                reference = torch.zeros(1, device=device)
                output = torch.randn(1, 5 + 2, 4, 5, device=device)
                head = SimpleNamespace(grids=[torch.zeros(1)], num_classes=2)

                decoded, grid = YOLOXHead.get_output_and_grid(head, output.clone(), 0, 8, reference)

                self.assertEqual(decoded.dtype, reference.dtype)
                self.assertEqual(decoded.device, reference.device)
                self.assertEqual(grid.dtype, reference.dtype)
                self.assertEqual(grid.device, reference.device)

                head.hw = [(4, 5)]
                head.strides = [8]
                inference = YOLOXHead.decode_outputs(head, decoded, reference=reference)
                self.assertEqual(inference.dtype, reference.dtype)
                self.assertEqual(inference.device, reference.device)

    def test_iou_ops_accept_mps_float_tensors(self):
        for device in self.devices():
            with self.subTest(device=device):
                pred = torch.tensor([[10.0, 10.0, 4.0, 4.0]], device=device)
                target = torch.tensor([[11.0, 10.0, 4.0, 4.0]], device=device)

                loss = IOUloss()(pred, target)
                iou = bboxes_iou(
                    torch.tensor([[8.0, 8.0, 12.0, 12.0]], device=device),
                    torch.tensor([[9.0, 8.0, 13.0, 12.0]], device=device),
                    xyxy=True,
                )

                self.assertEqual(loss.device, pred.device)
                self.assertEqual(iou.device, pred.device)
                self.assertTrue(torch.isfinite(loss).all())
                self.assertTrue(torch.isfinite(iou).all())


if __name__ == "__main__":
    unittest.main()
