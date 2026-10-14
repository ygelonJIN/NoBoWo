import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[4]
YOLOX_ROOT = ROOT / "third_party" / "YOLOX"
sys.path.insert(0, str(YOLOX_ROOT))

import torch
from torch.utils.data import TensorDataset

from yolox.exp.yolox_base import Exp


class YoloDataloaderStabilityTests(unittest.TestCase):
    def test_eval_loader_is_single_process(self):
        dataset = TensorDataset(torch.zeros(4, 1), torch.zeros(4, 1))
        exp = SimpleNamespace(
            data_num_workers=4,
            get_eval_dataset=lambda **kwargs: dataset,
        )

        loader = Exp.get_eval_loader(exp, batch_size=2, is_distributed=False)

        self.assertEqual(loader.num_workers, 0)
        self.assertEqual(loader.pin_memory, torch.cuda.is_available())
        self.assertEqual(len(next(iter(loader))), 2)


if __name__ == "__main__":
    unittest.main()
