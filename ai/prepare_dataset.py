"""Validate a human-reviewed vision manifest and create chronological GROUP holdouts.

No dataset is bundled. Metadata declarations must also be checked by a human curator.
This command does not train, download weights, or report model performance.
"""
import argparse
from datetime import datetime
import json
from pathlib import Path

from PIL import Image

try:
    from .audit_data import file_hash
except ImportError:
    from audit_data import file_hash


def inside(root, value):
    if not isinstance(value, str):
        raise ValueError("Paths must be strings relative to the manifest directory")
    path = (root / value).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("Dataset file missing or outside the manifest directory")
    return path


def annotations(path):
    classes = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        values = line.split()
        if len(values) != 5 or values[0] not in ("0", "1"):
            raise ValueError("Expected YOLO rows: class_id x_center y_center width height")
        coords = [float(value) for value in values[1:]]
        if not all(0 <= value <= 1 for value in coords) or min(coords[2:]) <= 0:
            raise ValueError("Invalid normalized bounding box")
        x, y, width, height = coords
        if x - width / 2 < 0 or x + width / 2 > 1 or y - height / 2 < 0 or y + height / 2 > 1:
            raise ValueError("Bounding box extends outside the image")
        classes.append(int(values[0]))
    return classes


def dhash(path):
    with Image.open(path) as image:
        gray = image.convert("L").resize((9, 8))
        pixels = list(gray.tobytes())
        result = 0
        for y in range(8):
            for x in range(8):
                result = (result << 1) | int(pixels[y * 9 + x] > pixels[y * 9 + x + 1])
        return result


def split_groups(records, embargo_seconds=60):
    """No random frame split: entire incident/capture groups remain together."""
    groups = {}
    for record in records:
        groups.setdefault(record["group_id"], []).append(record)
    ordered = sorted(groups, key=lambda key: (min(r["time"] for r in groups[key]), key))
    if len(ordered) < 3:
        raise ValueError("Need at least three independent groups; this is only a structural minimum")
    ntrain = max(1, min(len(ordered) - 2, int(len(ordered) * 0.7)))
    nval = max(1, min(len(ordered) - ntrain - 1, int(len(ordered) * 0.15)))
    mapping = {key: "train" if i < ntrain else "validation" if i < ntrain + nval else "test" for i, key in enumerate(ordered)}
    output = [{**record, "split": mapping[record["group_id"]]} for record in records]
    partitions = {name: [r for r in output if r["split"] == name] for name in ("train", "validation", "test")}
    for left, right in (("train", "validation"), ("validation", "test")):
        if max(r["time"] for r in partitions[left]) + embargo_seconds >= min(r["time"] for r in partitions[right]):
            raise ValueError("Temporal overlap/embargo violation between holdouts; collect or regroup capture sessions")
    for name, partition in partitions.items():
        # Both target classes AND reviewed negative frames are needed in each holdout.
        if not all(any(cls in row["classes"] for row in partition) for cls in (0, 1)) or not any(not row["classes"] for row in partition):
            raise ValueError(f"{name} lacks fire, smoke or reviewed negative support")
    return output


def prepare(manifest, output, embargo_seconds=60):
    manifest = Path(manifest).resolve()
    root = manifest.parent
    records = []
    ids, hashes = set(), set()
    sessions, incidents = {}, {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if not isinstance(row, dict) or row.get("source") != "real" or row.get("label_origin") != "independent_human" or row.get("reviewed") is not True:
            raise ValueError("Only explicitly real, independently human-reviewed samples are eligible; simulation/rule labels are blocked")
        required = ("sample_id", "group_id", "session_id", "site_id", "camera_id", "captured_at", "provenance")
        if any(not isinstance(row.get(key), str) or not row[key].strip() for key in required):
            raise ValueError("Missing sample/group/session/site/camera/time/provenance metadata")
        if row["sample_id"] in ids:
            raise ValueError("Duplicate sample_id")
        ids.add(row["sample_id"])
        captured = datetime.fromisoformat(row["captured_at"].replace("Z", "+00:00"))
        if captured.tzinfo is None:
            raise ValueError("captured_at needs an explicit timezone")
        for key, index in (("session_id", sessions), ("incident_id", incidents)):
            value = row.get(key)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ValueError("Session/incident identifiers must be nonempty strings")
            if value:
                # Incident/session IDs are globally unique across the manifest.
                if value in index and index[value] != row["group_id"]:
                    raise ValueError("The same session/incident appears in different groups")
                index[value] = row["group_id"]
        image, label = inside(root, row.get("image")), inside(root, row.get("annotation"))
        # Ultralytics expects matching images/... and labels/... sidecars.
        relative = image.relative_to(root)
        if "images" not in relative.parts:
            raise ValueError("Place images under an images/ directory")
        index = len(relative.parts) - 1 - list(reversed(relative.parts)).index("images")
        expected = root.joinpath(*relative.parts[:index], "labels", *relative.parts[index + 1:]).with_suffix(".txt")
        if expected.resolve() != label:
            raise ValueError("Annotation must be the matching labels/ sidecar")
        digest = file_hash(image)
        if digest in hashes:
            raise ValueError("Exact duplicate image content; deduplicate before splitting")
        hashes.add(digest)
        records.append({**row, "image": str(image), "annotation": str(label), "image_sha256": digest,
                        "annotation_sha256": file_hash(label), "dhash": dhash(image),
                        "time": captured.timestamp(), "classes": annotations(label)})
    result = split_groups(records, embargo_seconds)
    # Near-duplicate heuristic is a guard, not a proof against all visual leakage.
    for i, first in enumerate(result):
        for other in result[i + 1:]:
            if first["split"] != other["split"] and (first["dhash"] ^ other["dhash"]).bit_count() <= 4:
                raise ValueError("Potential near-duplicate images across splits; review, deduplicate or group them")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    public = [{k: v for k, v in row.items() if k not in ("time", "dhash")} for row in result]
    report = {"schema_version": 1, "manifest_sha256": file_hash(manifest), "split_method": "chronological_group_holdout",
              "embargo_seconds": embargo_seconds, "class_names": {"0": "fire", "1": "smoke"}, "records": public,
              "training_performed": False, "sufficiency": "structural_checks_only_not_evidence_of_statistical_power"}
    (output / "splits.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for split in ("train", "validation", "test"):
        (output / f"{split}.txt").write_text("".join(row["image"] + "\n" for row in result if row["split"] == split), encoding="utf-8")
    # JSON string quoting is valid YAML and handles Windows absolute paths.
    yaml = "\n".join(f"{key}: {json.dumps(str((output / (split + '.txt')).resolve()))}" for key, split in (("train", "train"), ("val", "validation"), ("test", "test")))
    yaml += '\nnames: {0: fire, 1: smoke}\n'
    (output / "dataset.yaml").write_text(yaml, encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--embargo-seconds", type=int, default=60)
    args = parser.parse_args()
    if args.embargo_seconds < 0:
        parser.error("Embargo must not be negative")
    try:
        result = prepare(args.manifest, args.output, args.embargo_seconds)
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(2, f"Dataset blocked: {exc}\n")
    print(json.dumps({"samples": len(result["records"]), "training_performed": False}))


if __name__ == "__main__":
    main()
