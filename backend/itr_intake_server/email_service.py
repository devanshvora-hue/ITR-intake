"""E-mail outbox service: templates, queueing, the sender interface and the
delivery loop used by the separate worker process (`email_worker.py`).

Flow
----
1. A request handler calls `queue_ca_email`, which writes a row to
   `email_outbox` (status 'pending') and returns. Nothing is sent in the request.
2. The worker calls `process_due_emails`. For each due row it asks an
   `EmailSender` to send, then records 'sent' / 'simulated', schedules a retry
   (1 min, 5 min, 30 min, 2 h) or marks the row 'dead'.
3. Only `SimulatedSender` exists in this stage. It deposits the message in the
   development-only `dev_mailbox`; it never touches the network. A row it
   handles is recorded as 'simulated', never 'sent', so a simulation can not
   be mistaken for real delivery.

Secrets
-------
Verification and reset messages contain a one-time link, so their rows are
`sensitive`: the body exists only while the message is waiting. It is cleared
when the message is delivered, when delivery finally fails, when a newer link
replaces it, or when `body_expires_at` (the link's own expiry) passes,
whichever is first. Link and body text are never logged and never put in
reprs or error codes; logs carry the template, the outbox id, a masked
recipient and a short status/error code.
"""

import logging
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from . import repository as repo
from .dev_outbox import DevOutbox

logger = logging.getLogger("itr_intake.email")

TEMPLATE_VERIFY_EMAIL = "ca_verify_email"
TEMPLATE_PASSWORD_RESET = "ca_password_reset"
TEMPLATE_CLIENT_SIGN_IN = "client_sign_in"

# Seconds to wait after the 1st, 2nd, 3rd and 4th failed attempt. A 5th failure is final.
RETRY_DELAYS = (60, 5 * 60, 30 * 60, 2 * 60 * 60)
CLAIM_LEASE = timedelta(minutes=5)

_LINK = re.compile(r"https?://\S+")
_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def mask_email(address: str) -> str:
    """'jane@example.test' -> 'j***@example.test' (for logs and operator output)."""
    local, _, domain = address.partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"


# --- messages and senders ---------------------------------------------------------------------


@dataclass(frozen=True)
class EmailMessage:
    outbox_id: str
    template: str
    to: str
    subject: str
    body: str
    expires_at: str | None  # when a sensitive body stops being valid

    @property
    def link(self) -> str | None:
        match = _LINK.search(self.body)
        return match.group(0) if match else None

    def __repr__(self) -> str:  # never show the body or link
        return f"EmailMessage(outbox_id={self.outbox_id!r}, template={self.template!r}, to={mask_email(self.to)!r})"


@dataclass(frozen=True)
class SendOutcome:
    simulated: bool
    provider_message_id: str | None = None


class EmailSendError(Exception):
    """A failed send. `code` is a short fixed code (never provider text or data);
    `retryable` says whether trying again can help."""

    def __init__(self, code: str, *, retryable: bool = True) -> None:
        if not _ERROR_CODE.match(code):
            code = "send_failed"
        self.code = code
        self.retryable = retryable
        super().__init__(code)


class EmailSender(Protocol):
    def send(self, message: EmailMessage) -> SendOutcome: ...


class SimulatedSender:
    """Development-only sender: stores the message in the simulated inbox. No
    network access. It refuses to be built outside development."""

    def __init__(self, dev_outbox: DevOutbox, *, development: bool) -> None:
        if not development:
            raise ValueError("The simulated sender is only available in the development environment.")
        self._outbox = dev_outbox

    def send(self, message: EmailMessage) -> SendOutcome:
        expires = message.expires_at or _stamp(datetime.now(UTC) + timedelta(hours=1))
        self._outbox.add(
            outbox_id=message.outbox_id, to=message.to, subject=message.subject,
            body="DEVELOPMENT SIMULATION - this email was not sent.\n\n" + message.body,
            link=message.link, expires_at=expires,
        )
        return SendOutcome(simulated=True)


class ProviderSender(ABC):
    """Shape of a future real adapter (SMTP or an e-mail API). Subclasses
    implement `_deliver`; any exception they raise becomes a retryable
    `EmailSendError` with a fixed code, so provider text can not leak into the
    database or logs. No provider is implemented or chosen in this stage."""

    @abstractmethod
    def _deliver(self, message: EmailMessage) -> str | None:
        """Send the message; return the provider's message id, if any."""

    def send(self, message: EmailMessage) -> SendOutcome:
        try:
            return SendOutcome(simulated=False, provider_message_id=self._deliver(message))
        except EmailSendError:
            raise
        except Exception:
            raise EmailSendError("provider_error") from None


# --- templates ---------------------------------------------------------------------------------


def render_verification_email(link: str, ttl: timedelta) -> tuple[str, str]:
    hours = int(ttl.total_seconds() // 3600)
    body = (
        "Please confirm your email address for ITR Intake by opening this link:\n\n"
        f"{link}\n\n"
        f"The link works once and expires in {hours} hours. Confirming your email does not approve your "
        "account; an administrator must approve it before you can sign in.\n\n"
        "If you did not register, ignore this message."
    )
    return "Verify your ITR Intake email address", body


def render_password_reset_email(link: str, ttl: timedelta) -> tuple[str, str]:
    minutes = int(ttl.total_seconds() // 60)
    body = (
        "Someone asked to reset the password for this ITR Intake account. To choose a new password, open:\n\n"
        f"{link}\n\n"
        f"The link works once and expires in {minutes} minutes. Resetting your password signs you out "
        "everywhere.\n\n"
        "If you did not ask for this, ignore this message; your password has not changed."
    )
    return "Reset your ITR Intake password", body


def render_client_sign_in_email(link: str, ttl: timedelta) -> tuple[str, str]:
    minutes = int(ttl.total_seconds() // 60)
    body = (
        "Someone used your email address to start an income tax intake with a CA firm on ITR Intake. "
        "To continue, open this link:\n\n"
        f"{link}\n\n"
        f"The link works once and expires in {minutes} minutes.\n\n"
        "If this was not you, ignore this message; nothing has been shared."
    )
    return "Continue your ITR Intake", body


# --- queueing --------------------------------------------------------------------------------------


def queue_ca_email(conn, *, template: str, recipient: str, token: str, link: str, ttl: timedelta,
                   firm_id: str | None = None, now: datetime | None = None) -> dict:
    """Queue a verification or password-reset e-mail for a freshly issued
    token (`token` is "<challenge_id>.<secret>"; only the challenge id enters
    the idempotency key). Earlier undelivered messages of the same kind for
    this recipient are superseded and their bodies cleared. The body (with the
    link) is kept only until delivery or the token's expiry."""
    renderers = {TEMPLATE_VERIFY_EMAIL: render_verification_email, TEMPLATE_PASSWORD_RESET: render_password_reset_email,
                 TEMPLATE_CLIENT_SIGN_IN: render_client_sign_in_email}
    if template not in renderers:
        raise ValueError("unknown template")
    moment = now or datetime.now(UTC)
    subject, body = renderers[template](link, ttl)
    challenge_id = token.split(".", 1)[0]
    with repo._atomic(conn):
        repo.supersede_pending_emails(conn, template=template, recipient=recipient)
        entry, _ = repo.enqueue_email(
            conn, idempotency_key=f"{template}:{challenge_id}", template=template, recipient=recipient,
            subject=subject, body_text=body, firm_id=firm_id, sensitive=True, body_expires_at=_stamp(moment + ttl),
        )
    logger.info("email queued template=%s id=%s to=%s", template, entry["id"], mask_email(recipient))
    return entry


# --- delivery --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class ProcessSummary:
    delivered: int = 0
    retried: int = 0
    dead: int = 0
    expired: int = 0
    skipped: int = 0


def next_attempt_time(attempts_so_far: int, now: datetime) -> str | None:
    """When to retry after the (attempts_so_far + 1)th attempt failed; None
    when the retries are used up and the message is dead."""
    if attempts_so_far >= len(RETRY_DELAYS):
        return None
    return _stamp(now + timedelta(seconds=RETRY_DELAYS[attempts_so_far]))


def process_due_emails(conn, sender: EmailSender, *, now: datetime | None = None, limit: int = 50) -> ProcessSummary:
    """Send every due message once. Safe to run from several workers: each
    message is claimed first. `now` can be given so tests can move time."""
    moment = now or datetime.now(UTC)
    stamp = _stamp(moment)
    expired = repo.expire_sensitive_email_bodies(conn, stamp)
    delivered = retried = dead = skipped = 0

    for row in repo.list_due_emails(conn, stamp, limit=limit):
        if not repo.claim_email(conn, row["id"], expected_next_attempt_at=row["next_attempt_at"],
                                lease_until=_stamp(moment + CLAIM_LEASE)):
            skipped += 1
            continue
        masked = mask_email(row["recipient"])
        if row["body_text"] is None:
            repo.mark_email_failed(conn, row["id"], error_code="body_missing", next_attempt_at=None)
            logger.warning("email dead template=%s id=%s to=%s code=body_missing", row["template"], row["id"], masked)
            dead += 1
            continue
        message = EmailMessage(row["id"], row["template"], row["recipient"], row["subject"], row["body_text"],
                               row["body_expires_at"])
        try:
            outcome = sender.send(message)
        except EmailSendError as exc:
            code, retryable = exc.code, exc.retryable
        except Exception:  # an unexpected sender bug: record a fixed code, never the exception text
            code, retryable = "unexpected_error", True
        else:
            repo.mark_email_delivered(conn, row["id"], simulated=outcome.simulated,
                                      provider_message_id=outcome.provider_message_id, clear_body=bool(row["sensitive"]))
            logger.info("email %s template=%s id=%s to=%s", "simulated" if outcome.simulated else "sent",
                        row["template"], row["id"], masked)
            delivered += 1
            continue

        retry_at = next_attempt_time(row["attempts"], moment) if retryable else None
        repo.mark_email_failed(conn, row["id"], error_code=code, next_attempt_at=retry_at)
        if retry_at:
            logger.warning("email failed, will retry template=%s id=%s to=%s code=%s attempt=%d retry_at=%s",
                           row["template"], row["id"], masked, code, row["attempts"] + 1, retry_at)
            retried += 1
        else:
            logger.error("email dead template=%s id=%s to=%s code=%s attempts=%d",
                         row["template"], row["id"], masked, code, row["attempts"] + 1)
            dead += 1
    return ProcessSummary(delivered, retried, dead, expired, skipped)
