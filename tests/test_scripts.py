import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills" / "qianchuan-creative-director" / "scripts"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


class ScriptTests(unittest.TestCase):
    def test_report_analysis(self):
        module = load("analyze_report")
        rows, mapping = module.load_report(ROOT / "examples" / "sample-report.csv")
        result = module.analyze(rows, 1.5)
        self.assertEqual(len(rows), 4)
        self.assertEqual(mapping["spend"], "消耗")
        self.assertEqual(result["segments"]["高消耗且达标"], 2)
        self.assertEqual(len(result["test_matrix"]), 4)

    def test_owned_master_matching(self):
        module = load("match_owned_masters")
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            platform = root / "platform"
            masters = root / "masters"
            platform.mkdir()
            masters.mkdir()
            (platform / "creative.mp4").write_bytes(b"owned-content")
            (masters / "creative-original.mp4").write_bytes(b"owned-content")
            result = module.match(platform, masters)
            self.assertEqual(result["matches"][0]["status"], "exact_hash")
            self.assertFalse(result["matches"][0]["requires_human_review"])


if __name__ == "__main__":
    unittest.main()
