#!/usr/bin/env python3
"""Import the checked-in SQLite universe into an empty Supabase project.

Usage:
  POSTGRES_URL='postgresql://...' python scripts/import_sqlite_to_postgres.py

The script is idempotent: existing primary keys are left untouched.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import psycopg


ROOT = Path(__file__).resolve().parent.parent
SQLITE_PATH = ROOT / "data/universe.db"
SCHEMA_PATH = ROOT / "supabase/migrations/001_universe.sql"

TABLES = {
    "meta": ("k", "v"),
    "galaxies": ("id", "name", "cx", "cy", "cz", "nx", "ny", "nz", "radius"),
    "regions": ("id", "galaxy", "name", "cx", "cy", "cz", "radius"),
    "accounts": (
        "id", "login", "kind", "name", "galaxy", "region", "cx", "cy", "cz", "nx", "ny", "nz",
        "truncated", "src", "fetched_at", "placed_at", "placement_version", "origin", "vec",
    ),
    "repos": (
        "id", "account", "name", "desc", "topics", "lang", "stars", "archived", "created", "pushed",
        "license", "observed", "src", "packages", "ring", "angle", "x", "y", "z", "placed_at", "visible",
    ),
    "edges": ("s", "t", "kind", "via"),
    "packages": ("eco", "name", "repo"),
}


def main() -> None:
    url = os.environ.get("POSTGRES_URL_NON_POOLING") or os.environ.get("POSTGRES_URL")
    if not url:
        raise SystemExit("POSTGRES_URL is required")

    source = sqlite3.connect(SQLITE_PATH)
    source.row_factory = sqlite3.Row
    with psycopg.connect(url) as target:
        target.execute(SCHEMA_PATH.read_text(), prepare=False)
        for table, columns in TABLES.items():
            rows = source.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
            if not rows:
                print(f"{table}: 0")
                continue
            target_columns = tuple('"desc"' if c == "desc" else c for c in columns)
            placeholders = ", ".join(["%s"] * len(columns))
            statement = (
                f"INSERT INTO {table} ({', '.join(target_columns)}) VALUES ({placeholders}) "
                "ON CONFLICT DO NOTHING"
            )
            for start in range(0, len(rows), 500):
                batch = [tuple(row[c] for c in columns) for row in rows[start:start + 500]]
                target.executemany(statement, batch)
            print(f"{table}: {len(rows)}")
        target.commit()

    source.close()
    print("Supabase import complete")


if __name__ == "__main__":
    main()
