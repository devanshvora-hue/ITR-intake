"""Development-only simulated inbox.

The e-mail worker's simulated sender deposits each message here instead of
sending it. Rows live in the `dev_mailbox` table only until the link inside
them expires (they are deleted then), are never logged, and are written only
when the server or worker runs in the development environment. In
production this class is never instantiated and its page does not exist.
"""

from dataclasses import dataclass

from .db import connect, new_id, utc_now

MAX_MESSAGES = 50


@dataclass(frozen=True)
class DevEmail:
    id: str
    to: str
    subject: str
    body: str
    link: str | None
    created_at: str

    def __repr__(self) -> str:  # keep link and body (which hold secrets) out of reprs
        return f"DevEmail(id={self.id!r}, to={self.to!r}, subject={self.subject!r})"


class DevOutbox:
    """The simulated inbox, backed by the database so the API server and the
    separate worker process share it."""

    def __init__(self, database_path) -> None:
        self._path = database_path

    def add(self, *, outbox_id: str, to: str, subject: str, body: str, link: str | None, expires_at: str) -> None:
        """Store one simulated message (replacing an earlier attempt for the
        same outbox entry), and drop expired ones."""
        conn = connect(self._path)
        try:
            now = utc_now()
            conn.execute("DELETE FROM dev_mailbox WHERE expires_at <= ?", (now,))
            conn.execute(
                "INSERT INTO dev_mailbox (id, outbox_id, recipient, subject, body_text, link, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (outbox_id) DO UPDATE SET "
                "recipient = excluded.recipient, subject = excluded.subject, body_text = excluded.body_text, "
                "link = excluded.link, expires_at = excluded.expires_at",
                (new_id(), outbox_id, to, subject, body, link, now, expires_at),
            )
        finally:
            conn.close()

    def messages(self) -> list[DevEmail]:
        """Unexpired simulated messages, newest first (expired ones are deleted)."""
        conn = connect(self._path)
        try:
            conn.execute("DELETE FROM dev_mailbox WHERE expires_at <= ?", (utc_now(),))
            rows = conn.execute(
                "SELECT id, recipient, subject, body_text, link, created_at FROM dev_mailbox "
                "ORDER BY created_at DESC LIMIT ?", (MAX_MESSAGES,)).fetchall()
        finally:
            conn.close()
        return [DevEmail(r["id"], r["recipient"], r["subject"], r["body_text"], r["link"], r["created_at"]) for r in rows]

    def queued_count(self) -> int:
        """Messages waiting for the worker (pending or retrying); counts only."""
        conn = connect(self._path)
        try:
            return conn.execute("SELECT count(*) FROM email_outbox WHERE status IN ('pending', 'failed')").fetchone()[0]
        finally:
            conn.close()
