"""Synthetic DEMO unit fixtures only; assertions are NOT model evaluation results."""
import json
import random
from pathlib import Path
import tempfile
import unittest

from ai.audit_data import rule_label
from ai.evaluate import confusion, evaluate
from ai.prepare_dataset import split_groups, prepare
from PIL import Image


class MlToolTests(unittest.TestCase):
    def test_metrics_include_unavailable_in_coverage_and_detection_recall(self):
        # DEMO arithmetic fixture, not predictions from best.pt or real sensors.
        report = confusion([True, True, False, False, True], [True, False, False, True, None])
        self.assertEqual(report["confusion_matrix"]["counts"], [[1, 1, 0], [1, 1, 1]])
        self.assertEqual(report["available_only"]["precision"], 0.5)
        self.assertAlmostEqual(report["end_to_end_detection_recall"], 1 / 3)
        self.assertEqual(report["coverage"], 0.8)
        self.assertNotIn("accuracy", report)

    def test_undefined_metrics_are_null_not_fabricated(self):
        report = confusion([True, False], [None, None])
        self.assertIsNone(report["available_only"]["precision"])
        self.assertIsNone(report["available_only"]["f1"])
        self.assertEqual(report["end_to_end_detection_recall"], 0)
        self.assertRaises(ValueError, confusion, [True], [])

    def test_groups_are_chronological_and_never_split_across_partitions(self):
        records = []
        for group in range(6):
            # DEMO metadata: test only structural split behavior.
            for offset, classes in enumerate(([0], [1], [])):
                records.append({"sample_id": f"DEMO-{group}-{offset}", "group_id": f"DEMO-group-{group}",
                                "time": group * 3600 + offset, "classes": classes})
        output = split_groups(records)
        for group in {row["group_id"] for row in output}:
            self.assertEqual(len({row["split"] for row in output if row["group_id"] == group}), 1)
        self.assertEqual(output[-1]["split"], "test")
        with self.assertRaises(ValueError):
            split_groups(records, embargo_seconds=100000)

    def test_missing_class_support_blocks_dataset(self):
        with self.assertRaises(ValueError):
            split_groups([{"group_id": str(i), "time": i * 3600, "classes": []} for i in range(6)])

    def test_simulated_labels_are_blocked_before_any_image_is_used(self):
        temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        temp_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="fireguard-ml-demo-", dir=temp_root) as directory:
            root = Path(directory)
            self.assertEqual(root.resolve().parent, temp_root.resolve())
            manifest = root / "manifest.jsonl"
            manifest.write_text(json.dumps({"source": "simulation", "label_origin": "threshold_rule", "reviewed": True}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "simulation/rule labels"):
                prepare(manifest, root / "output")
            self.assertFalse((root / "output").exists())

    def test_threshold_status_is_a_rule_output(self):
        self.assertEqual(rule_label({"temperature": 60, "smoke": 0, "gas": 0, "flame": 0}), "WARN")
        self.assertEqual(rule_label({"temperature": 60.1, "smoke": 0, "gas": 0, "flame": 0}), "DANGER")
        self.assertIsNone(rule_label({"temperature": None, "smoke": 0, "gas": 0, "flame": 0}))

    def test_demo_contract_fixture_freezes_files_and_rejects_missing_predictions(self):
        # This simulates a curator's metadata contract, not real field data. All
        # generated images/predictions stay in a disposable DEMO test directory.
        # No scores from this fixture are used in model_card or assessment results.
        temp_root = Path(__file__).resolve().parents[1] / ".tmp"
        temp_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="fireguard-ml-demo-", dir=temp_root) as directory:
            root = Path(directory)
            self.assertEqual(root.resolve().parent, temp_root.resolve())
            (root / "images").mkdir()
            (root / "labels").mkdir()
            rows = []
            rng = random.Random(42)
            for group in range(6):
                for category in range(3):
                    stem = f"DEMO-{group}-{category}"
                    image = root / "images" / f"{stem}.png"
                    Image.frombytes("RGB", (32, 32), rng.randbytes(32 * 32 * 3)).save(image)
                    annotation = root / "labels" / f"{stem}.txt"
                    annotation.write_text(f"{category} 0.5 0.5 0.2 0.2\n" if category < 2 else "", encoding="utf-8")
                    rows.append({"sample_id": stem, "image": f"images/{stem}.png", "annotation": f"labels/{stem}.txt",
                                 "source": "real", "label_origin": "independent_human", "reviewed": True,
                                 "provenance": "DEMO metadata-contract fixture; not real evidence",
                                 "group_id": f"DEMO-group-{group}", "session_id": f"DEMO-session-{group}",
                                 "site_id": "DEMO-site", "camera_id": "DEMO-camera",
                                 "captured_at": f"2026-10-{group + 1:02d}T12:00:0{category}Z"})
            manifest = root / "DEMO-manifest.jsonl"
            manifest.write_text("\n".join(json.dumps(row) for row in rows), encoding="utf-8")
            prepared = prepare(manifest, root / "prepared")
            self.assertFalse(prepared["training_performed"])
            selected = [row for row in prepared["records"] if row["split"] == "test"]
            predictions = [{"sample_id": row["sample_id"], "available": False, "hasFire": None,
                            "detected_labels": None, "model_sha256": "f" * 64, "confidence_threshold": 0.15} for row in selected]
            saved = root / "DEMO-predictions.jsonl"
            saved.write_text("\n".join(json.dumps(row) for row in predictions), encoding="utf-8")
            report = evaluate(root / "prepared/splits.json", saved)
            self.assertEqual(report["frame_presence"]["coverage"], 0)
            self.assertIn("smoke", report["per_class_presence"])
            saved.write_text("\n".join(json.dumps(row) for row in predictions[:-1]), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cover every holdout"):
                evaluate(root / "prepared/splits.json", saved)
            # Any mutation after freezing must fail, even before metrics are computed.
            Path(selected[0]["annotation"]).write_text("", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "changed after split"):
                evaluate(root / "prepared/splits.json", saved)


if __name__ == "__main__":
    unittest.main()
