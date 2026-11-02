"""SQLite-backed key/value store.

Replaces the single JSON blob that was re-read and re-serialised in full on
every ``get`` and ``set``. That made the store O(n^2) in the size of the
database: 4.4 MB rewritten per call at ~22 calls for a 33-page document, and
projected at ~3 TB of I/O for a 10,000-page one.

The interface is intentionally identical to ``JsonDatabase`` so call sites do
not change.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid

from pydantic import BaseModel

from utilis.timing import timed


class SqliteDatabase:
    """Dict-like persistent store on SQLite (WAL, one row per key)."""

    def __init__(self, file_path: str = "database/quill.db", json_fallback: str = "database/database.json"):
        self.file_path = file_path
        self.json_fallback = json_fallback
        directory = os.path.dirname(file_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(file_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA synchronous=NORMAL")
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        self._conn.commit()
        self._migrate_once()

    # --- internals ---------------------------------------------------------
    def _migrate_once(self) -> None:
        """Import any pre-existing JSON blob exactly once, then leave it alone."""
        if not self.json_fallback or not os.path.exists(self.json_fallback):
            return
        marker = self.get("__migrated_from_json__")
        if marker is not None:
            return
        try:
            with open(self.json_fallback, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError, ValueError):
            return
        if isinstance(data, dict):
            with self._lock:
                for key, value in data.items():
                    self._conn.execute(
                        "INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)",
                        (str(key), json.dumps(value)),
                    )
                self._conn.execute(
                    "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
                    ("__migrated_from_json__", json.dumps({"from": self.json_fallback, "keys": len(data)})),
                )
                self._conn.commit()

    def _serialise(self, value) -> str:
        if isinstance(value, BaseModel):
            value = value.model_dump()
        elif not isinstance(value, (str, int, float, bool, type(None))):
            value = json.loads(json.dumps(value, default=str))
        return value if isinstance(value, str) else json.dumps(value)

    # --- public API (mirrors JsonDatabase) --------------------------------
    @timed("SqliteDatabase.get")
    def get(self, key: str, default=None):
        row = self._conn.execute("SELECT value FROM kv WHERE key = ?", (str(key),)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row[0])
        except json.JSONDecodeError:
            return row[0]

    @timed("SqliteDatabase.set")
    def set(self, key: str, value) -> None:
        payload = self._serialise(value)
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", (str(key), payload)
            )
            self._conn.commit()

    @timed("SqliteDatabase.delete")
    def delete(self, key: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM kv WHERE key = ?", (str(key),))
            self._conn.commit()
        return cur.rowcount > 0

    @timed("SqliteDatabase.list_keys")
    def list_keys(self) -> list:
        return [r[0] for r in self._conn.execute("SELECT key FROM kv")]

    # --- extras ------------------------------------------------------------
    def count(self) -> int:
        return int(self._conn.execute("SELECT COUNT(*) FROM kv").fetchone()[0])

    def size_bytes(self) -> int:
        total = 0
        for suffix in ("", "-wal", "-shm"):
            path = self.file_path + suffix
            if os.path.exists(path):
                total += os.path.getsize(path)
        return total

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def open_store(file_path: str = "database/quill.db") -> SqliteDatabase:
    """Convenience factory mirroring the old ``JsonDatabase()`` construction."""
    return SqliteDatabase(file_path)
