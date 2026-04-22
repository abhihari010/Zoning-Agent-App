from __future__ import annotations

import argparse
import json
from pathlib import Path

import sys


REPO_ROOT = Path(__file__).resolve().parents[2]
API_PATH = REPO_ROOT / "apps" / "api"
if str(API_PATH) not in sys.path:
    sys.path.insert(0, str(API_PATH))

from app.models import SourceRegistryEntry
from app.storage import store


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed or replace zoning source registry entries in the API database."
    )
    parser.add_argument(
        "source_file",
        nargs="?",
        default=str(API_PATH / "app" / "data" / "source_registry.json"),
        help="Path to a JSON file containing a list of source registry entries.",
    )
    args = parser.parse_args()

    source_path = Path(args.source_file)
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("Source file must contain a top-level JSON array.")

    count = 0
    for item in payload:
        entry = SourceRegistryEntry.model_validate(item)
        store.upsert_source(entry)
        count += 1

    print(f"Seeded {count} sources from {source_path}")


if __name__ == "__main__":
    main()
