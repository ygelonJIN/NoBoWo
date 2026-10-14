import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[4]
YOLOX_ROOT = ROOT / "third_party" / "YOLOX"
sys.path.insert(0, str(YOLOX_ROOT))

from yolox.layers import fast_coco_eval_api as api
from yolox.layers.fast_coco_eval_api import COCOeval_opt
from yolox.layers.jit_ops import ensure_ninja_available


class YoloNinjaFallbackTests(unittest.TestCase):
    def test_user_installed_ninja_is_added_to_path(self):
        if importlib.util.find_spec("ninja") is None:
            self.skipTest("ninja package is not installed")

        self.assertTrue(ensure_ninja_available())
        self.assertIsNotNone(__import__("shutil").which("ninja"))

    def test_fast_coco_eval_falls_back_to_standard_pycocotools(self):
        old_module = api._FAST_MODULE
        old_unavailable = api._FAST_MODULE_UNAVAILABLE
        try:
            api._FAST_MODULE = None
            api._FAST_MODULE_UNAVAILABLE = False
            with mock.patch.object(api.FastCOCOEvalOp, "load", side_effect=RuntimeError("Ninja is required")):
                evaluator = COCOeval_opt.__new__(COCOeval_opt)
                evaluator.module = api._load_fast_module()
                self.assertIsNone(evaluator.module)
                with mock.patch.object(api.COCOeval, "evaluate", return_value="standard-evaluate") as evaluate:
                    self.assertEqual(evaluator.evaluate(), "standard-evaluate")
                    evaluate.assert_called_once()
                with mock.patch.object(api.COCOeval, "accumulate", return_value="standard-accumulate") as accumulate:
                    self.assertEqual(evaluator.accumulate(), "standard-accumulate")
                    accumulate.assert_called_once()
        finally:
            api._FAST_MODULE = old_module
            api._FAST_MODULE_UNAVAILABLE = old_unavailable


if __name__ == "__main__":
    unittest.main()
