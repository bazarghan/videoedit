"""Small, durable SQLite store. All media lives outside the database."""

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from cryptography.fernet import Fernet

DATA = Path(os.getenv("DATA_DIR", "/data")).resolve()
DATA.mkdir(parents=True, exist_ok=True)
os.chmod(DATA, 0o700)
for name in ("sources", "previews", "subtitles", "assets", "renders", "work"):
    (DATA / name).mkdir(exist_ok=True)
key_path = DATA / "encryption.key"
if not key_path.exists():
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(Fernet.generate_key())
cipher = Fernet(key_path.read_bytes())
lock = threading.RLock()


@contextmanager
def db():
    con = sqlite3.connect(DATA / "videoedit.sqlite3", timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    try:
        yield con
        con.commit()
    except BaseException:
        con.rollback()
        raise
    finally:
        con.close()


with db() as con:
    con.executescript("""
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, source TEXT,
        preview TEXT, thumbnail TEXT, metadata TEXT NOT NULL DEFAULT '{}', edit TEXT NOT NULL DEFAULT '{}',
        status TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT, project_id TEXT,
        payload TEXT, status TEXT, progress REAL DEFAULT 0, bytes INTEGER DEFAULT 0,
        speed REAL DEFAULT 0, created REAL, started REAL, finished REAL, error TEXT,
        result_id TEXT, duration REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, path TEXT, name TEXT);
    CREATE TABLE IF NOT EXISTS subtitles (id TEXT PRIMARY KEY, project_id TEXT, title TEXT,
        language TEXT, codec TEXT, cues TEXT, ass_path TEXT, editable INTEGER);
    CREATE TABLE IF NOT EXISTS clips (id TEXT PRIMARY KEY, project_id TEXT, name TEXT, path TEXT,
        metadata TEXT, created REAL, preview INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires REAL);
    """)


def execute(sql, args=()):
    with lock, db() as con:
        cur = con.execute(sql, args)
        return cur.rowcount


def rows(sql, args=()):
    with lock, db() as con:
        return [dict(r) for r in con.execute(sql, args).fetchall()]


def one(sql, args=()):
    results = rows(sql, args)
    return results[0] if results else None


def uid():
    return uuid.uuid4().hex


def setting(key, default=None):
    row = one("SELECT value FROM settings WHERE key=?", (key,))
    return json.loads(cipher.decrypt(row["value"].encode())) if row else default


def set_setting(key, value):
    value = cipher.encrypt(json.dumps(value).encode()).decode()
    execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, value))


def encrypt(value):
    return cipher.encrypt(json.dumps(value).encode()).decode()


def decrypt(value):
    return json.loads(cipher.decrypt(value.encode()))


def job(kind, project_id, payload):
    ident = uid()
    execute(
        "INSERT INTO jobs(id,kind,project_id,payload,status,created) VALUES (?,?,?,?,?,?)",
        (ident, kind, project_id, encrypt(payload), "queued", time.time()),
    )
    return ident


def update_job(ident, **values):
    assert all(
        k
        in {
            "status",
            "progress",
            "bytes",
            "speed",
            "started",
            "finished",
            "error",
            "result_id",
            "duration",
        }
        for k in values
    )
    execute(
        "UPDATE jobs SET " + ",".join(k + "=?" for k in values) + " WHERE id=?",
        (*values.values(), ident),
    )


def directory_bytes(directory):
    total = 0
    for path in Path(directory).rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except FileNotFoundError:
            continue
    return total


def used_bytes():
    return directory_bytes(DATA)


def space_for(size=0):
    import shutil

    limit = int(setting("storage_limit_gb", 20)) * 1024**3
    if used_bytes() + size > limit or shutil.disk_usage(DATA).free < size + 1024**3:
        raise ValueError(
            "Storage is nearly full. Free space or increase the storage limit before continuing."
        )
