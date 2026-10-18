"""Read-only audit. Rule-label consistency is NOT a trained-model metric."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import pickletools
import sqlite3
import zipfile


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_checkpoint(path):
    """Inspect pickle instructions without unpickling/executing the checkpoint."""
    path = Path(path)
    report = {"file": path.name, "bytes": path.stat().st_size, "sha256": file_hash(path),
              "inspection": "static_pickle_instructions_only", "executed": False,
              "provenance_verified": False, "runtime_verified": False, "declared_class_names": None}
    with zipfile.ZipFile(path) as archive:
        members = [entry for entry in archive.infolist() if entry.filename.endswith("/data.pkl")]
        if len(members) != 1 or members[0].file_size > 16 * 1024 * 1024:
            raise ValueError("Expected one bounded PyTorch data.pkl metadata member")
        operations = list(pickletools.genops(archive.read(members[0])))
        candidates = []
        for index, (_, arg, _) in enumerate(operations):
            if arg != "names":
                continue
            following = operations[index + 1:index + 65]
            values = []
            for op, value, _ in following:
                if op.name == "SETITEMS":
                    break
                if op.name in ("BININT", "BININT1", "BININT2", "INT", "BINUNICODE", "SHORT_BINUNICODE", "UNICODE"):
                    values.append(value)
            if values and len(values) % 2 == 0:
                pairs = list(zip(values[::2], values[1::2]))
                if all(isinstance(k, int) and isinstance(v, str) for k, v in pairs):
                    candidates.append(dict(pairs))
        if len(candidates) == 1:
            report["declared_class_names"] = candidates[0]
    return report


def rule_label(row):
    values = [row[k] for k in ("temperature", "smoke", "gas")]
    if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        return None
    if row["flame"] not in (0, 1):
        return None
    temp, smoke, gas = values
    if row["flame"] or temp > 60 or smoke > 60 or gas > 60:
        return "DANGER"
    return "WARN" if temp > 45 or smoke > 30 or gas > 30 else "NORMAL"


def audit_database(path):
    path = Path(path).resolve()
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN")
        rows = [dict(row) for row in connection.execute("SELECT * FROM sensor_logs ORDER BY id")]
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        events = connection.execute("SELECT COUNT(*) FROM event_logs").fetchone()[0]
    fields = ("temperature", "smoke", "gas", "flame")
    sources = Counter(row.get("source") or "UNKNOWN" for row in rows)
    labels = Counter(row.get("status") or "UNKNOWN" for row in rows)
    ranges = {}
    invalid = {}
    for key, bounds in {"temperature": (-40, 125), "smoke": (0, 100), "gas": (0, 100), "flame": (0, 1)}.items():
        values = [row[key] for row in rows if isinstance(row[key], (int, float)) and math.isfinite(row[key])]
        ranges[key] = {"min": min(values) if values else None, "max": max(values) if values else None}
        invalid[key] = sum(not isinstance(row[key], (int, float)) or not math.isfinite(row[key])
                           or not bounds[0] <= row[key] <= bounds[1] or (key == "flame" and row[key] not in (0, 1)) for row in rows)
    timestamps = []
    invalid_times = 0
    for row in rows:
        try:
            # Legacy SQLite timestamps are UTC by convention, without an explicit zone.
            stamp = datetime.fromisoformat(row["timestamp"])
            timestamps.append((stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)).timestamp())
        except (ValueError, TypeError):
            invalid_times += 1
    deltas = [b - a for a, b in zip(timestamps, timestamps[1:])]
    danger_runs = 0
    previous_danger = False
    for row in rows:
        danger = row.get("status") == "DANGER"
        danger_runs += int(danger and not previous_danger)
        previous_danger = danger
    return {
        "database_sha256": file_hash(path), "wal_present": Path(str(path) + "-wal").exists(),
        "sensor_snapshot_sha256": hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest(),
        "sqlite_integrity": integrity, "sensor_rows": len(rows), "event_rows": events,
        "sources": dict(sources), "stored_status_counts": dict(labels),
        "danger_share": labels["DANGER"] / len(rows) if rows else None,
        "timestamp_range_raw": {"first": min((r["timestamp"] for r in rows if r["timestamp"]), default=None),
                                "last": max((r["timestamp"] for r in rows if r["timestamp"]), default=None)},
        "missing": {key: sum(row.get(key) is None for row in rows) for key in (*fields, "timestamp", "status", "source")},
        "ranges": ranges, "invalid_or_missing_sensor_values": invalid, "invalid_timestamps": invalid_times,
        "duplicate_timestamps": len(rows) - len({row["timestamp"] for row in rows}),
        "duplicate_sensor_vectors": len(rows) - len({tuple(row[key] for key in fields) for row in rows}),
        "non_increasing_timestamp_steps": sum(delta <= 0 for delta in deltas),
        "gaps_over_10_seconds": sum(delta > 10 for delta in deltas),
        "contiguous_danger_runs_by_row_order": danger_runs,
        "default_rule_status_matches": sum(rule_label(row) == row["status"] for row in rows),
        "rule_consistency_is_not_model_evaluation": True,
        "independent_ground_truth_present": False,
        "independent_label_evidence": "No annotation table/manifest was supplied; status is an operational rule output, not adjudicated truth.",
        "supervised_training_ready": False,
        "blocking_reasons": ["No independently adjudicated real-device event labels", "No incident/session grouping for holdout splits",
                             "Simulation cannot establish real-world model effectiveness"]
    }


def audit(database, weights):
    return {"schema_version": 1, "sensor_data": audit_database(database), "checkpoint": inspect_checkpoint(weights),
            "training_performed": False, "model_evaluation_metrics": None,
            "vision_dataset_present": False, "conclusion": "Insufficient evidence for supervised training or deployment performance claims"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path("data/fire_guard.db"))
    parser.add_argument("--weights", type=Path, default=Path("ai/best.pt"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = json.dumps(audit(args.database, args.weights), ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report)


if __name__ == "__main__":
    main()
