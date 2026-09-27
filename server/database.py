"""Small SQLite/Postgres compatibility layer for the universe ledger.

Local development keeps using the checked-in SQLite snapshot. Vercel uses the
Supabase Postgres connection injected as POSTGRES_URL.
"""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable


class Database:
    def __init__(self, sqlite_path: Path):
        self.url = os.environ.get("POSTGRES_URL")
        self.kind = "postgres" if self.url else "sqlite"
        self._sqlite_path = sqlite_path
        self._con = self._connect()

    def _connect(self):
        if self.kind == "postgres":
            import psycopg
            from psycopg.rows import dict_row

            return psycopg.connect(self.url, row_factory=dict_row, autocommit=True)
        con = sqlite3.connect(self._sqlite_path, check_same_thread=False)
        con.row_factory = sqlite3.Row
        return con

    def _sql(self, statement: str) -> str:
        if self.kind == "postgres":
            return statement.replace("?", "%s")
        return statement

    def execute(self, statement: str, params: Iterable[Any] = ()):
        return self._con.execute(self._sql(statement), tuple(params))

    def executemany(self, statement: str, params: Iterable[Iterable[Any]]):
        cursor = self._con.cursor()
        cursor.executemany(self._sql(statement), params)
        return cursor

    def commit(self) -> None:
        self._con.commit()

    def rollback(self) -> None:
        self._con.rollback()

    @contextmanager
    def transaction(self):
        if self.kind == "postgres":
            with self._con.transaction():
                yield
            return
        try:
            yield
            self._con.commit()
        except Exception:
            self._con.rollback()
            raise


def connect(sqlite_path: Path) -> Database:
    return Database(sqlite_path)
