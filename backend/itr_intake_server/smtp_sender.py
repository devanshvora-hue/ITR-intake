"""Production e-mail delivery over SMTP (standard library only).

Works with any provider that offers SMTP submission (Resend, Postmark, Amazon
SES, Mailgun, a mailbox provider, ...). Configured only by environment
variables; nothing is read from files:

    ITR_SMTP_HOST       required to enable delivery, e.g. smtp.example.com
    ITR_EMAIL_FROM      required sender address, e.g. no-reply@example.com
    ITR_SMTP_PORT       default 587 (STARTTLS) or 465 (implicit TLS)
    ITR_SMTP_TLS        "starttls" (default) or "implicit"
    ITR_SMTP_USERNAME   optional; set together with ITR_SMTP_PASSWORD
    ITR_SMTP_PASSWORD   optional; never logged or shown in reprs

If none of these is set, e-mail stays "not configured" (nothing is queued in
production). If some are set but the configuration is incomplete or invalid,
startup fails with a message naming the variable, never its value.

The connection always uses TLS with certificate verification; there is no
plain-text mode. A failure becomes an `EmailSendError` with a fixed code
(provider text never reaches the database or logs): permanent rejections are
not retried, temporary and connection problems are.
"""

import os
import re
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage as MimeMessage
from email.utils import formatdate, make_msgid

from .email_service import EmailMessage, EmailSendError, ProviderSender

_ENV_NAMES = ("ITR_SMTP_HOST", "ITR_EMAIL_FROM", "ITR_SMTP_PORT", "ITR_SMTP_TLS", "ITR_SMTP_USERNAME",
              "ITR_SMTP_PASSWORD")
_ADDRESS = re.compile(r"^[^@\s<>\"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
_HOST = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
TIMEOUT_SECONDS = 20


class SmtpConfigError(ValueError):
    """Invalid SMTP configuration. The message names variables only."""


@dataclass(frozen=True)
class SmtpConfig:
    host: str
    from_address: str
    port: int = 587
    tls: str = "starttls"  # or "implicit"
    username: str | None = None
    password: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not _HOST.match(self.host or ""):
            raise SmtpConfigError("ITR_SMTP_HOST must be a host name")
        if not _ADDRESS.match(self.from_address or ""):
            raise SmtpConfigError("ITR_EMAIL_FROM must be a plain e-mail address")
        if not 1 <= self.port <= 65535:
            raise SmtpConfigError("ITR_SMTP_PORT must be a port number")
        if self.tls not in ("starttls", "implicit"):
            raise SmtpConfigError('ITR_SMTP_TLS must be "starttls" or "implicit"')
        if bool(self.username) != bool(self.password):
            raise SmtpConfigError("ITR_SMTP_USERNAME and ITR_SMTP_PASSWORD must be set together")

    @classmethod
    def from_env(cls, environ=None) -> "SmtpConfig | None":
        env = os.environ if environ is None else environ
        values = {name: (env.get(name) or "").strip() for name in _ENV_NAMES}
        if not any(values.values()):
            return None
        if not values["ITR_SMTP_HOST"] or not values["ITR_EMAIL_FROM"]:
            raise SmtpConfigError("ITR_SMTP_HOST and ITR_EMAIL_FROM are both required to enable e-mail")
        try:
            port = int(values["ITR_SMTP_PORT"] or (465 if values["ITR_SMTP_TLS"] == "implicit" else 587))
        except ValueError:
            raise SmtpConfigError("ITR_SMTP_PORT must be a port number") from None
        return cls(host=values["ITR_SMTP_HOST"], from_address=values["ITR_EMAIL_FROM"], port=port,
                   tls=values["ITR_SMTP_TLS"] or "starttls", username=values["ITR_SMTP_USERNAME"] or None,
                   password=values["ITR_SMTP_PASSWORD"] or None)


class SmtpSender(ProviderSender):
    """Sends each message over its own TLS connection (fine for prototype volumes)."""

    def __init__(self, config: SmtpConfig) -> None:
        self._config = config

    def __repr__(self) -> str:
        return f"SmtpSender(host={self._config.host!r}, port={self._config.port})"

    def _build(self, message: EmailMessage) -> MimeMessage:
        mime = MimeMessage()
        mime["From"] = self._config.from_address
        mime["To"] = message.to
        mime["Subject"] = message.subject
        mime["Date"] = formatdate(usegmt=True)
        mime["Message-ID"] = make_msgid(domain=self._config.from_address.rsplit("@", 1)[1])
        mime["Auto-Submitted"] = "auto-generated"
        mime.set_content(message.body)
        return mime

    def _deliver(self, message: EmailMessage) -> str | None:
        config = self._config
        try:
            mime = self._build(message)
        except ValueError:  # e.g. a line break in a header: never send
            raise EmailSendError("invalid_message", retryable=False) from None
        context = ssl.create_default_context()
        try:
            if config.tls == "implicit":
                server = smtplib.SMTP_SSL(config.host, config.port, timeout=TIMEOUT_SECONDS, context=context)
            else:
                server = smtplib.SMTP(config.host, config.port, timeout=TIMEOUT_SECONDS)
            with server:
                if config.tls == "starttls":
                    server.starttls(context=context)
                if config.username:
                    server.login(config.username, config.password)
                server.send_message(mime)
        except smtplib.SMTPRecipientsRefused:
            raise EmailSendError("recipient_refused", retryable=False) from None
        except smtplib.SMTPAuthenticationError:
            raise EmailSendError("auth_failed") from None  # a configuration fix lets the retry succeed
        except smtplib.SMTPNotSupportedError:
            raise EmailSendError("tls_unavailable") from None
        except smtplib.SMTPResponseException as exc:
            if 500 <= exc.smtp_code < 600:
                raise EmailSendError("rejected", retryable=False) from None
            raise EmailSendError("temporary_failure") from None
        except ssl.SSLError:
            raise EmailSendError("tls_failed") from None
        except (smtplib.SMTPException, OSError):
            raise EmailSendError("connection_failed") from None
        return mime["Message-ID"]
