"""Consistent SQLite backup, including committed WAL pages; source is read-only."""
import argparse
from pathlib import Path
import sqlite3
from contextlib import closing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    source, destination = args.source.resolve(), args.destination.resolve()
    if not source.is_file():
        parser.error("Source does not exist")
    if source == destination or destination.exists():
        parser.error("Destination must be a new file distinct from source")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation also prevents accidentally overwriting an existing backup.
    with destination.open("xb"):
        pass
    # On failure an incomplete backup is retained for inspection, never used as source.
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
        with closing(sqlite3.connect(destination)) as backup:
            original.backup(backup)
    print(f"Backup created: {destination}")


if __name__ == "__main__":
    main()
