"""Small transactional local store. Credentials never belong here."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid4().hex


class Store:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "factory.sqlite3"
        self.lock = threading.RLock()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS records (kind TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(kind,id))")
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    def connect(self):
        return sqlite3.connect(self.path, timeout=15)

    def get(self, kind: str, identifier: str) -> dict | None:
        with self.lock, self.connect() as db:
            row = db.execute("SELECT data FROM records WHERE kind=? AND id=?", (kind, identifier)).fetchone()
        return json.loads(row[0]) if row else None

    def all(self, kind: str) -> list[dict]:
        with self.lock, self.connect() as db:
            rows = db.execute("SELECT data FROM records WHERE kind=? ORDER BY rowid DESC", (kind,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def put(self, kind: str, item: dict) -> dict:
        with self.lock, self.connect() as db:
            db.execute("INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
                       (kind, item["id"], json.dumps(item, allow_nan=False)))
        return item

    def patch(self, kind: str, identifier: str, **changes) -> dict:
        with self.lock:
            item = self.get(kind, identifier)
            if item is None:
                raise KeyError(identifier)
            item.update(changes)
            return self.put(kind, item)

    def delete(self, kind: str, identifier: str):
        with self.lock, self.connect() as db:
            db.execute("DELETE FROM records WHERE kind=? AND id=?", (kind, identifier))
