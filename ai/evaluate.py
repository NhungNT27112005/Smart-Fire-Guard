"""Evaluate complete saved predictions against an independently reviewed holdout.

No default predictions, missing-row imputation, training, or fabricated accuracy.
"""
import argparse
from collections import defaultdict
import json
from pathlib import Path

try:
    from .audit_data import file_hash
    from .prepare_dataset import annotations
except ImportError:
    from audit_data import file_hash
    from prepare_dataset import annotations


def confusion(truth, predictions):
    if len(truth) != len(predictions) or not truth:
        raise ValueError("Need aligned, nonempty truth and predictions")
    matrix = [[0, 0, 0], [0, 0, 0]]
    for expected, actual in zip(truth, predictions):
        if type(expected) is not bool or (actual is not None and type(actual) is not bool):
            raise ValueError("Truth is boolean; prediction is boolean or None (unavailable)")
        matrix[int(expected)][2 if actual is None else int(actual)] += 1
    tn, fp, absent_negative = matrix[0]
    fn, tp, absent_positive = matrix[1]
    divide = lambda num, den: num / den if den else None
    return {
        "confusion_matrix": {"true_rows": ["no_hazard", "hazard"], "predicted_columns": ["no_detection", "hazard", "unavailable"], "counts": matrix},
        "support": {"no_hazard": sum(matrix[0]), "hazard": sum(matrix[1])},
        "coverage": divide(tn + fp + fn + tp, len(truth)),
        "available_only": {"precision": divide(tp, tp + fp), "recall": divide(tp, tp + fn), "f1": divide(2 * tp, 2 * tp + fp + fn)},
        "end_to_end_detection_recall": divide(tp, tp + fn + absent_positive),
        "unavailable_positives": absent_positive, "unavailable_negatives": absent_negative,
        "unavailable_is_not_a_negative_prediction": True
    }


def evaluate(splits_file, prediction_file, split="test"):
    if split not in ("validation", "test"):
        raise ValueError("Evaluate held-out validation or test data, never training")
    prepared = json.loads(Path(splits_file).read_text(encoding="utf-8"))
    if prepared.get("split_method") != "chronological_group_holdout":
        raise ValueError("Use a checked chronological/group split manifest")
    records = [row for row in prepared["records"] if row["split"] == split]
    if not records or any(row.get("source") != "real" or row.get("label_origin") != "independent_human" or row.get("reviewed") is not True for row in records):
        raise ValueError("Need independently reviewed real holdout data")
    group_splits, session_splits, incident_splits, content_splits = {}, {}, {}, {}
    for row in prepared["records"]:
        for key, index in (("group_id", group_splits), ("session_id", session_splits), ("incident_id", incident_splits), ("image_sha256", content_splits)):
            value = row.get(key)
            if value:
                if value in index and index[value] != row["split"]:
                    raise ValueError("Group/session/incident/content overlap between splits")
                index[value] = row["split"]
    for row in records:
        if file_hash(row["image"]) != row["image_sha256"] or file_hash(row["annotation"]) != row["annotation_sha256"]:
            raise ValueError("Holdout files changed after split preparation")
        if annotations(Path(row["annotation"])) != row["classes"]:
            raise ValueError("Ground truth differs from frozen annotations")
    by_id = {row["sample_id"]: row for row in records}
    predictions, predicted_labels = {}, {}
    model_hashes, cutoffs = set(), set()
    for line in Path(prediction_file).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        key = row["sample_id"]
        if key not in by_id or key in predictions:
            raise ValueError("Unexpected or duplicate prediction ID")
        if type(row.get("available")) is not bool or (row["available"] and type(row.get("hasFire")) is not bool) or (not row["available"] and row.get("hasFire") is not None):
            raise ValueError("Invalid availability/decision contract")
        digest = row.get("model_sha256")
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Every prediction needs a model SHA-256")
        model_hashes.add(digest)
        cutoff = row.get("confidence_threshold")
        if isinstance(cutoff, bool) or not isinstance(cutoff, (int, float)) or not 0 < cutoff < 1:
            raise ValueError("Freeze and record the inference confidence threshold")
        cutoffs.add(cutoff)
        if row.get("held"):
            raise ValueError("Use raw frame detections, not temporally held advisory outputs")
        labels = row.get("detected_labels")
        if row["available"]:
            if not isinstance(labels, list) or any(value not in ("fire", "smoke") for value in labels) or bool(labels) != row["hasFire"]:
                raise ValueError("Available predictions need matching fire/smoke detected_labels")
            predicted_labels[key] = set(labels)
        else:
            if labels is not None:
                raise ValueError("Unavailable predictions need detected_labels=null")
            predicted_labels[key] = None
        predictions[key] = row["hasFire"] if row["available"] else None
    if set(predictions) != set(by_id) or len(model_hashes) != 1 or len(cutoffs) != 1:
        raise ValueError("Predictions must cover every holdout sample with exactly one model version")
    truth = [bool(row["classes"]) for row in records]
    decisions = [predictions[row["sample_id"]] for row in records]
    if set(truth) != {False, True}:
        raise ValueError("Holdout needs both positive and negative ground truth")
    groups = defaultdict(list)
    for row, actual, predicted in zip(records, truth, decisions):
        groups[row["group_id"]].append((actual, predicted))
    event_truth, event_predictions = [], []
    for items in groups.values():
        event_truth.append(any(item[0] for item in items))
        # A partially missing group is not labelled safely negative.
        event_predictions.append(True if any(p is True for _, p in items) else None if any(p is None for _, p in items) else False)
    per_class = {}
    for class_id, name in ((0, "fire"), (1, "smoke")):
        per_class[name] = confusion([class_id in row["classes"] for row in records],
                                    [None if predicted_labels[row["sample_id"]] is None else name in predicted_labels[row["sample_id"]] for row in records])
    return {"schema_version": 1, "split": split, "model_sha256": next(iter(model_hashes)),
            "confidence_threshold": next(iter(cutoffs)), "samples": len(records),
            "groups": len(groups), "frame_presence": confusion(truth, decisions),
            "per_class_presence": per_class,
            "group_any_presence": confusion(event_truth, event_predictions),
            "not_a_box_localization_metric": True,
            "limits": ["Reported labels/provenance must be independently audited", "Binary presence metrics do not replace per-class box matching/mAP",
                       "Group holdout cannot prove absence of contamination in unknown pretrained weights", "No causal prediction of future fire is evaluated"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("splits", type=Path)
    parser.add_argument("predictions", type=Path)
    parser.add_argument("--split", choices=("validation", "test"), default="test")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = evaluate(args.splits, args.predictions, args.split)
    except (ValueError, KeyError, OSError) as exc:
        parser.exit(2, f"Evaluation blocked: {exc}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Evaluation saved from supplied ground truth and complete predictions; no model training performed.")


if __name__ == "__main__":
    main()
