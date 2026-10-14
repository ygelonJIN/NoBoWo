import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
YOLOX_ROOT = ROOT / "third_party" / "YOLOX"
sys.path.insert(0, str(YOLOX_ROOT))

from yolox.exp.base_exp import BaseExp


class DummyExp(BaseExp):
    def get_model(self):
        return None

    def get_dataset(self, cache=False, cache_type="ram"):
        return None

    def get_data_loader(self, batch_size, is_distributed):
        return None

    def get_optimizer(self, batch_size):
        return None

    def get_lr_scheduler(self, lr, iters_per_epoch, **kwargs):
        return None

    def get_evaluator(self):
        return None

    def eval(self, model, evaluator, weights):
        return None


class YoloExpReprTests(unittest.TestCase):
    def test_repr_does_not_recurse_through_bound_methods(self):
        exp = DummyExp()

        def get_dataset(self, cache=False, cache_type="ram"):
            return None

        exp.get_dataset = get_dataset.__get__(exp, type(exp))
        rendered = repr(exp)

        self.assertIn("<method>", rendered)
        self.assertNotIn("maximum recursion depth exceeded", rendered)
        self.assertLess(len(rendered), 20_000)

    def test_engine_template_does_not_bind_overrides_to_exp_instance(self):
        source = (ROOT / "packages" / "main" / "src" / "main.ts").read_text(encoding="utf-8")
        self.assertIn("exp.get_dataset = get_dataset", source)
        self.assertIn("exp.get_eval_dataset = get_eval_dataset", source)
        self.assertIn("exp.get_evaluator = get_evaluator", source)
        self.assertNotIn(".__get__(exp, type(exp))", source)


if __name__ == "__main__":
    unittest.main()
