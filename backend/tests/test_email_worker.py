"""E-mail outbox service and worker: queueing, simulated delivery, retries,
dead letters, secret retention and safe logging. Temporary databases,
synthetic addresses, and no network (sockets are blocked)."""

import hashlib
import logging
import socket
from datetime import UTC, datetime, timedelta

import pytest

import itr_intake_server.repository as repo
from itr_intake_server import admin
from itr_intake_server import email_service as emails
from itr_intake_server import email_worker
from itr_intake_server.db import MIGRATIONS_DIR, initialize_database
from itr_intake_server.dev_outbox import DevOutbox

SECRET = "SECRETSECRETSECRETSECRETSECRETSECRETSECRE"  # 43 characters, like a real token secret
TOKEN = f"11111111-1111-4111-8111-111111111111.{SECRET}"
LINK = f"https://app.example.test/ca/verify-email#token={TOKEN}"
TO = "jane.synthetic@example.test"
T0 = datetime(2026, 1, 1, 9, 0, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


@pytest.fixture
def path(tmp_path):
    return tmp_path / "email.db"


@pytest.fixture
def conn(path):
    c = initialize_database(path)
    yield c
    c.close()


@pytest.fixture
def sender(path, conn):
    return emails.SimulatedSender(DevOutbox(path), development=True)


class FailingSender:
    def __init__(self, error=None):
        self.error = error or emails.EmailSendError("smtp_unavailable")
        self.calls = 0

    def send(self, message):
        self.calls += 1
        raise self.error


def queue(conn, *, template=emails.TEMPLATE_VERIFY_EMAIL, token=TOKEN, ttl=timedelta(hours=24), to=TO, now=T0):
    entry = emails.queue_ca_email(conn, template=template, recipient=to, token=token,
                                  link=LINK.replace(TOKEN, token), ttl=ttl, now=now)
    # The repository stamps rows with the real clock; tests move time, so make the row due at `now`.
    conn.execute("UPDATE email_outbox SET next_attempt_at = ? WHERE id = ?", (stamp(now), entry["id"]))
    return row(conn, entry["id"])


def stamp(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def row(conn, entry_id):
    return dict(conn.execute("SELECT * FROM email_outbox WHERE id = ?", (entry_id,)).fetchone())


# === schema ========================================================================================

def test_migration_0001_is_unchanged_and_0002_adds_the_columns(conn):
    digest = hashlib.sha256((MIGRATIONS_DIR / "0001_initial_schema.sql").read_bytes()).hexdigest()
    assert digest == "90452c1d385fd0e5bd08dd703e13825c66b83b49641d029d35da9583d1fdb1e3"
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(email_outbox)")}
    assert {"sensitive", "body_expires_at"} <= columns
    assert conn.execute("SELECT count(*) FROM dev_mailbox").fetchone()[0] == 0


def test_a_sensitive_message_needs_an_expiry(conn):
    with pytest.raises(repo.InvalidInput):
        repo.enqueue_email(conn, idempotency_key="k", template="t", recipient=TO, subject="s", body_text="b",
                           sensitive=True)


# === queueing and templates ============================================================================

def test_queueing_stores_a_pending_sensitive_message_with_an_expiry(conn):
    entry = queue(conn)
    assert entry["status"] == "pending" and entry["sensitive"] == 1 and LINK in entry["body_text"]
    assert entry["body_expires_at"] == "2026-01-02T09:00:00.000000Z"
    assert entry["idempotency_key"] == f"{emails.TEMPLATE_VERIFY_EMAIL}:11111111-1111-4111-8111-111111111111"
    assert SECRET not in entry["idempotency_key"]  # the secret never becomes part of the key


def test_templates_say_what_they_are_for():
    subject, body = emails.render_verification_email(LINK, timedelta(hours=24))
    assert LINK in body and "24 hours" in body and "does not approve" in body
    subject2, body2 = emails.render_password_reset_email(LINK, timedelta(minutes=30))
    assert LINK in body2 and "30 minutes" in body2 and "signs you out" in body2
    assert subject != subject2


def test_a_new_link_supersedes_the_old_one_and_clears_its_body(conn):
    old = queue(conn)
    new = queue(conn, token=f"22222222-2222-4222-8222-222222222222.{SECRET}")
    assert row(conn, old["id"])["status"] == "superseded" and row(conn, old["id"])["body_text"] is None
    assert row(conn, new["id"])["status"] == "pending" and row(conn, new["id"])["body_text"]


def test_queueing_never_sends_anything(conn, path):
    queue(conn)
    assert DevOutbox(path).messages() == []  # nothing is delivered until the worker runs


# === simulated delivery and secret retention ==========================================================

def test_simulated_delivery_marks_simulated_and_clears_the_body(conn, sender, path):
    now = datetime.now(UTC)  # the simulated inbox expires against the real clock
    entry = queue(conn, now=now)
    summary = emails.process_due_emails(conn, sender, now=now)
    assert summary.delivered == 1 and summary.dead == 0
    done = row(conn, entry["id"])
    assert done["status"] == "simulated" and done["body_text"] is None and done["sent_at"]
    assert done["next_attempt_at"] is None and done["attempts"] == 1
    inbox = DevOutbox(path).messages()
    assert len(inbox) == 1 and inbox[0].link == LINK and "was not sent" in inbox[0].body
    assert SECRET not in repr(inbox[0])


def test_the_link_is_not_left_in_the_queue_after_delivery(conn, sender):
    queue(conn)
    emails.process_due_emails(conn, sender, now=T0)
    dump = [tuple(r) for r in conn.execute("SELECT * FROM email_outbox")]
    assert not any(SECRET in str(v) for v in dump[0])


def test_the_simulated_inbox_drops_a_message_when_its_link_expires(conn, sender, path):
    queue(conn, ttl=timedelta(minutes=30), now=datetime.now(UTC))
    emails.process_due_emails(conn, sender)
    assert len(DevOutbox(path).messages()) == 1
    conn.execute("UPDATE dev_mailbox SET expires_at = '2000-01-01T00:00:00.000000Z'")
    assert DevOutbox(path).messages() == []
    assert conn.execute("SELECT count(*) FROM dev_mailbox").fetchone()[0] == 0


def test_the_simulated_sender_exists_only_in_development(path, conn):
    with pytest.raises(ValueError):
        emails.SimulatedSender(DevOutbox(path), development=False)


# === failures, retries and dead letters ====================================================================

def test_failures_retry_after_1_5_30_minutes_and_2_hours_then_die(conn):
    entry = queue(conn)
    failing = FailingSender()
    expected_delays = [60, 300, 1800, 7200]
    now = T0
    for attempt, delay in enumerate(expected_delays, start=1):
        summary = emails.process_due_emails(conn, failing, now=now)
        assert summary.retried == 1 and summary.dead == 0
        current = row(conn, entry["id"])
        assert current["status"] == "failed" and current["attempts"] == attempt
        assert current["last_error"] == "smtp_unavailable"
        due = now + timedelta(seconds=delay)
        assert current["next_attempt_at"] == due.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        assert emails.process_due_emails(conn, failing, now=due - timedelta(seconds=1)).retried == 0  # not due yet
        assert failing.calls == attempt
        now = due
    summary = emails.process_due_emails(conn, failing, now=now)  # the fifth failure is final
    assert summary.dead == 1
    dead = row(conn, entry["id"])
    assert dead["status"] == "dead" and dead["attempts"] == 5 and dead["next_attempt_at"] is None
    assert dead["body_text"] is None  # the link does not outlive the last attempt
    assert emails.process_due_emails(conn, failing, now=now + timedelta(days=1)).retried == 0
    assert failing.calls == 5


def test_a_later_attempt_can_succeed(conn, sender):
    entry = queue(conn)
    emails.process_due_emails(conn, FailingSender(), now=T0)
    summary = emails.process_due_emails(conn, sender, now=T0 + timedelta(seconds=60))
    assert summary.delivered == 1
    done = row(conn, entry["id"])
    assert done["status"] == "simulated" and done["attempts"] == 2 and done["body_text"] is None


def test_a_non_retryable_error_is_dead_at_once(conn):
    entry = queue(conn)
    summary = emails.process_due_emails(conn, FailingSender(emails.EmailSendError("rejected", retryable=False)), now=T0)
    assert summary.dead == 1
    assert row(conn, entry["id"])["status"] == "dead" and row(conn, entry["id"])["body_text"] is None


def test_a_link_that_expires_while_retrying_is_cleared_and_dead(conn):
    entry = queue(conn, template=emails.TEMPLATE_PASSWORD_RESET, ttl=timedelta(minutes=30))
    failing = FailingSender()
    emails.process_due_emails(conn, failing, now=T0)                           # attempt 1 fails, retry at +1 min
    emails.process_due_emails(conn, failing, now=T0 + timedelta(minutes=1))    # attempt 2 fails, retry at +6 min
    emails.process_due_emails(conn, failing, now=T0 + timedelta(minutes=6))    # attempt 3 fails, retry at +36 min
    summary = emails.process_due_emails(conn, failing, now=T0 + timedelta(minutes=36))
    assert summary.expired == 1 and failing.calls == 3  # no fourth send with a dead link
    dead = row(conn, entry["id"])
    assert dead["status"] == "dead" and dead["last_error"] == "body_expired" and dead["body_text"] is None


def test_an_undelivered_message_is_cleared_when_it_expires(conn, sender):
    entry = queue(conn, ttl=timedelta(minutes=30))
    summary = emails.process_due_emails(conn, sender, now=T0 + timedelta(minutes=31))
    assert summary.expired == 1 and summary.delivered == 0
    assert row(conn, entry["id"])["status"] == "dead" and row(conn, entry["id"])["body_text"] is None


def test_unexpected_sender_errors_record_only_a_fixed_code(conn, caplog):
    class Boom:
        def send(self, message):
            raise RuntimeError(f"upstream said {LINK} and {SECRET}")

    entry = queue(conn)
    with caplog.at_level(logging.DEBUG):
        emails.process_due_emails(conn, Boom(), now=T0)
    current = row(conn, entry["id"])
    assert current["status"] == "failed" and current["last_error"] == "unexpected_error"
    assert SECRET not in caplog.text and SECRET not in current["last_error"]


def test_error_codes_cannot_carry_free_text():
    assert emails.EmailSendError("smtp_unavailable").code == "smtp_unavailable"
    assert emails.EmailSendError("550 mailbox jane@example.test not found").code == "send_failed"


def test_provider_adapter_shape_hides_provider_text(conn):
    class Adapter(emails.ProviderSender):
        def _deliver(self, message):
            raise ConnectionError(f"relay refused {message.to}")

    entry = queue(conn)
    emails.process_due_emails(conn, Adapter(), now=T0)
    current = row(conn, entry["id"])
    assert current["last_error"] == "provider_error" and TO not in str(current["last_error"])


def test_a_message_without_a_body_is_dead(conn, sender):
    entry, _ = repo.enqueue_email(conn, idempotency_key="plain", template="note", recipient=TO, subject="s",
                                  body_text=None)
    assert emails.process_due_emails(conn, sender, now=datetime.now(UTC) + timedelta(seconds=1)).dead == 1
    assert row(conn, entry["id"])["last_error"] == "body_missing"


# === claims (two workers) ===================================================================================

def test_a_claimed_message_is_not_sent_twice_and_returns_after_the_lease(conn, sender):
    entry = queue(conn)
    due, lease = entry["next_attempt_at"], stamp(T0 + timedelta(minutes=5))
    assert repo.claim_email(conn, entry["id"], expected_next_attempt_at=due, lease_until=lease) is True
    assert repo.claim_email(conn, entry["id"], expected_next_attempt_at=due, lease_until=lease) is False
    assert emails.process_due_emails(conn, sender, now=T0 + timedelta(minutes=1)).delivered == 0  # held elsewhere
    assert emails.process_due_emails(conn, sender, now=T0 + timedelta(minutes=6)).delivered == 1  # worker died: retried


# === safe logging ==========================================================================================

def test_logs_hold_no_links_or_full_addresses(conn, sender, caplog):
    with caplog.at_level(logging.DEBUG):
        queue(conn)
        emails.process_due_emails(conn, sender, now=T0)
        emails.process_due_emails(conn, FailingSender(), now=T0)
        queue(conn, token=f"33333333-3333-4333-8333-333333333333.{SECRET}", to="other.synthetic@example.test")
        emails.process_due_emails(conn, FailingSender(), now=T0)
    assert caplog.records
    for fragment in (SECRET, "https://", "token=", TO, "other.synthetic@"):
        assert fragment not in caplog.text
    assert "j***@example.test" in caplog.text


def test_messages_do_not_expose_their_body_in_reprs(conn):
    entry = queue(conn)
    message = emails.EmailMessage(entry["id"], entry["template"], TO, entry["subject"], entry["body_text"], None)
    assert SECRET not in repr(message) and TO not in repr(message)


def test_mask_email():
    assert emails.mask_email("jane@example.test") == "j***@example.test"
    assert emails.mask_email("nonsense") == "***"


# === the worker process ===================================================================================

def test_worker_refuses_to_run_outside_development(path, capsys, monkeypatch):
    monkeypatch.delenv("ITR_ENV", raising=False)
    assert email_worker.main(["--once", "--db", str(path)]) == 2
    assert "No email provider is configured" in capsys.readouterr().err
    assert not path.exists()  # it did not even create a database
    monkeypatch.setenv("ITR_ENV", "production")
    assert email_worker.main(["--once", "--dev", "--db", str(path)]) == 0  # --dev is an explicit choice


def test_worker_once_delivers_simulated_mail(conn, path, capsys):
    entry = queue(conn, now=datetime.now(UTC))
    assert email_worker.main(["--dev", "--once", "--db", str(path)]) == 0
    out = capsys.readouterr().out
    assert "simulated=1" in out and SECRET not in out and "https://" not in out
    assert row(conn, entry["id"])["status"] == "simulated"
    assert len(DevOutbox(path).messages()) == 1


def test_worker_interval_is_bounded(path, capsys):
    assert email_worker.main(["--dev", "--interval", "0", "--db", str(path)]) == 2


# === operator visibility ==================================================================================

def test_email_status_lists_failures_without_bodies(conn):
    queue(conn)
    emails.process_due_emails(conn, FailingSender(emails.EmailSendError("rejected", retryable=False)), now=T0)
    text = "\n".join(admin.email_status(conn))
    assert "dead=1" in text and "DEAD" in text and "j***@example.test" in text and "rejected" in text
    assert SECRET not in text and TO not in text and "https://" not in text


def test_email_status_cli(path, capsys):
    initialize_database(path).close()
    assert admin.main(["--db", str(path), "email-status"]) == 0
    assert "Email outbox: empty" in capsys.readouterr().out
