"""SQLite foundation: connections, migrations, UTC timestamps and IDs.

Standard library only. Every connection made through `connect()` enforces
foreign keys (SQLite leaves them off by default). Migrations are numbered SQL
files in `migrations/` (`0001_name.sql`, `0002_name.sql`, ...), applied in
order, each inside its own transaction, and recorded in `schema_migrations`
with a checksum. Re-running is safe: applied migrations are skipped, and an
applied migration whose file has since changed is refused rather than
silently diverging.

The default database lives in `backend/var/` (git-ignored). Nothing here
creates files elsewhere unless an explicit path is given.
"""

import hashlib
import re
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
VAR_DIR = BACKEND_DIR / "var"
DEFAULT_DATABASE_PATH = VAR_DIR / "itr_intake.db"
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

_MIGRATION_NAME = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")
_BUSY_TIMEOUT_MS = 5000

_SCHEMA_MIGRATIONS_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL CHECK (applied_at LIKE '____-__-__T__:__:__%Z')
) STRICT
"""


class MigrationError(RuntimeError):
    """A migration could not be applied, or the migration history is inconsistent."""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    path: Path

    @property
    def sql(self) -> str:
        return self.path.read_text(encoding="utf-8")

    @property
    def checksum(self) -> str:
        return hashlib.sha256(self.path.read_bytes()).hexdigest()


def utc_now() -> str:
    """Current UTC time as ISO-8601 text with microseconds and a trailing Z."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def new_id() -> str:
    """A new immutable internal identifier (UUID4, lower-case text)."""
    return str(uuid.uuid4())


def _refuse_private(path: Path) -> None:
    if any(part.lower() == "private" for part in path.resolve().parts):
        raise ValueError("refusing to place a database inside a Private/ folder")


def connect(path: str | Path = DEFAULT_DATABASE_PATH) -> sqlite3.Connection:
    """Open a connection with foreign keys enforced, rows as `sqlite3.Row`,
    a busy timeout and WAL journaling for file databases.

    The connection is in autocommit mode (`isolation_level=None`); callers
    open transactions explicitly (see `transaction()`).
    """
    is_memory = str(path) == ":memory:"
    if not is_memory:
        path = Path(path)
        _refuse_private(path)
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys = ON")
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        conn.close()
        raise RuntimeError("SQLite foreign-key enforcement could not be enabled")
    if not is_memory:
        conn.execute("PRAGMA journal_mode = WAL")
    return conn


class transaction:
    """`with transaction(conn):` runs a BEGIN IMMEDIATE ... COMMIT block and
    rolls back on any exception."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self) -> sqlite3.Connection:
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            self.conn.execute("COMMIT")
        elif self.conn.in_transaction:
            self.conn.execute("ROLLBACK")
        return False


def discover_migrations(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    """Numbered migrations in order. Unexpected .sql names, duplicate numbers
    and gaps are errors, so the history cannot be ambiguous."""
    migrations: list[Migration] = []
    for path in sorted(directory.glob("*.sql")):
        match = _MIGRATION_NAME.match(path.name)
        if not match:
            raise MigrationError(f"Migration file name not recognised: {path.name}")
        migrations.append(Migration(int(match[1]), match[2], path))
    versions = [m.version for m in migrations]
    if len(set(versions)) != len(versions):
        raise MigrationError("Duplicate migration version numbers.")
    if versions != list(range(1, len(versions) + 1)):
        raise MigrationError(f"Migration versions must be 1..N without gaps; found {versions}.")
    return migrations


def applied_migrations(conn: sqlite3.Connection) -> dict[int, sqlite3.Row]:
    conn.execute(_SCHEMA_MIGRATIONS_DDL)
    return {row["version"]: row for row in conn.execute("SELECT * FROM schema_migrations ORDER BY version")}


def apply_migrations(conn: sqlite3.Connection, directory: Path = MIGRATIONS_DIR) -> list[int]:
    """Apply pending migrations in order; return the versions applied now.

    Each migration and its schema_migrations row are committed together or
    not at all. A failing migration is rolled back and later migrations are
    not attempted.
    """
    if conn.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
        raise MigrationError("Foreign-key enforcement must be enabled; use itr_intake_server.db.connect().")
    if conn.in_transaction:
        raise MigrationError("Cannot migrate inside an open transaction.")

    migrations = discover_migrations(directory)
    applied = applied_migrations(conn)
    known = {m.version for m in migrations}
    unknown = sorted(set(applied) - known)
    if unknown:
        raise MigrationError(f"Database has migrations this code does not know: {unknown}.")
    for m in migrations:
        row = applied.get(m.version)
        if row is not None and row["checksum"] != m.checksum:
            raise MigrationError(f"Applied migration {m.version:04d}_{m.name} has been modified since it was applied.")

    done: list[int] = []
    for m in migrations:
        if m.version in applied:
            continue
        sql = m.sql
        # Transaction statements only; a trigger body's "BEGIN ... END;" is fine.
        if re.search(
            r"^\s*(BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?\s*;|COMMIT\b|ROLLBACK\b|END\s+TRANSACTION\b)",
            sql, re.IGNORECASE | re.MULTILINE,
        ):
            raise MigrationError(f"Migration {m.path.name} must not manage its own transaction.")
        # executescript() commits any open transaction before running, so the
        # whole migration, including its bookkeeping row, is one script that
        # opens and commits its own transaction. Values are integers, a
        # validated name, a hex digest and a timestamp, so inlining is safe.
        script = (
            "BEGIN IMMEDIATE;\n"
            f"{sql}\n;\n"
            "INSERT INTO schema_migrations (version, name, checksum, applied_at) "
            f"VALUES ({m.version}, '{m.name}', '{m.checksum}', '{utc_now()}');\n"
            "COMMIT;"
        )
        try:
            conn.executescript(script)
        except sqlite3.Error as exc:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise MigrationError(f"Migration {m.path.name} failed and was rolled back: {exc}") from exc
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise MigrationError(f"Migration {m.path.name} left foreign-key violations: {len(violations)} rows.")
        done.append(m.version)
    return done


def initialize_database(path: str | Path = DEFAULT_DATABASE_PATH, directory: Path = MIGRATIONS_DIR) -> sqlite3.Connection:
    """Open (creating if needed) and migrate a database; return the connection."""
    conn = connect(path)
    try:
        apply_migrations(conn, directory)
    except Exception:
        conn.close()
        raise
    return conn
