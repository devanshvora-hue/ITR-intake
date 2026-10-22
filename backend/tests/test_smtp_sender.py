"""Production e-mail over SMTP: configuration from environment variables, the
SMTP sender (TLS, login, fixed error codes), queueing in production and the
worker's production mode. A fake SMTP server stands in for the network;
synthetic addresses and credentials only."""

import smtplib
import socket
import ssl
from datetime import UTC, datetime

import pytest

from itr_intake_server import email_service as emails
from itr_intake_server import email_worker
from itr_intake_server.app import create_app
from itr_intake_server.db import initialize_database
from itr_intake_server.settings import Settings
from itr_intake_server.smtp_sender import SmtpConfig, SmtpConfigError, SmtpSender
from test_email_worker import SECRET, queue, row
from test_server_app import PROD_ORIGIN, db_rows, fast_scrypt, new_client  # noqa: F401  (fixture)

PASSWORD = "synthetic-smtp-password-123"
ENV = {"ITR_SMTP_HOST": "smtp.example.test", "ITR_EMAIL_FROM": "no-reply@example.test",
       "ITR_SMTP_USERNAME": "synthetic-user", "ITR_SMTP_PASSWORD": PASSWORD}
CONFIG = SmtpConfig(host="smtp.example.test", from_address="no-reply@example.test", username="synthetic-user",
                    password=PASSWORD)
PH = {"Origin": PROD_ORIGIN, "X-ITR-Request": "1"}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    real_connect = socket.socket.connect

    def refuse(*args, **kwargs):
        raise AssertionError("network access attempted")

    def loopback_only(sock, address):  # the event loop's own socket pair is loopback
        if not (isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1")):
            refuse()
        return real_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", loopback_only)
    monkeypatch.setattr(socket, "create_connection", refuse)
    for name in ENV | {"ITR_SMTP_PORT": "", "ITR_SMTP_TLS": "", "ITR_ENV": ""}:
        monkeypatch.delenv(name, raising=False)


class FakeSMTP:
    """Records what the sender does; `fail` maps a step to the exception it raises."""
    instances: list["FakeSMTP"] = []
    fail: dict = {}

    def __init__(self, host, port, timeout=None, context=None):
        if "connect" in FakeSMTP.fail:
            raise FakeSMTP.fail["connect"]
        self.host, self.port, self.implicit_context = host, port, context
        self.steps, self.sent = [], []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.steps.append("quit")

    def _step(self, name):
        self.steps.append(name)
        if name in FakeSMTP.fail:
            raise FakeSMTP.fail[name]

    def starttls(self, context=None):
        assert isinstance(context, ssl.SSLContext) and context.verify_mode == ssl.CERT_REQUIRED
        self._step("starttls")

    def login(self, user, password):
        self._step("login")
        self.credentials = (user, password)

    def send_message(self, mime):
        self._step("send")
        self.sent.append(mime)


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSMTP.instances, FakeSMTP.fail = [], {}
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP


def message(to="jane.synthetic@example.test"):
    return emails.EmailMessage("out-1", emails.TEMPLATE_CLIENT_SIGN_IN, to, "Continue your ITR Intake",
                               f"Open https://app.example.test/client/verify#token=x.{SECRET}", None)


# === configuration ==================================================================================================

def test_no_variables_means_not_configured():
    assert SmtpConfig.from_env({}) is None
    assert Settings(environment="production", allowed_origins=(PROD_ORIGIN,),
                    public_base_url=PROD_ORIGIN).email_delivery == "not_configured"


def test_a_full_configuration_is_read_from_the_environment():
    config = SmtpConfig.from_env(ENV)
    assert (config.host, config.port, config.tls, config.username) == ("smtp.example.test", 587, "starttls",
                                                                       "synthetic-user")
    assert SmtpConfig.from_env({**ENV, "ITR_SMTP_TLS": "implicit"}).port == 465
    assert SmtpConfig.from_env({"ITR_SMTP_HOST": "h.example.test", "ITR_EMAIL_FROM": "a@example.test"}).username is None


@pytest.mark.parametrize("changes, variable", [
    ({"ITR_SMTP_HOST": ""}, "ITR_SMTP_HOST"),
    ({"ITR_EMAIL_FROM": ""}, "ITR_EMAIL_FROM"),
    ({"ITR_EMAIL_FROM": "Name <a@example.test>"}, "ITR_EMAIL_FROM"),
    ({"ITR_EMAIL_FROM": "a@example.test\r\nBcc: x@example.test"}, "ITR_EMAIL_FROM"),
    ({"ITR_SMTP_PORT": "smtp"}, "ITR_SMTP_PORT"),
    ({"ITR_SMTP_PORT": "70000"}, "ITR_SMTP_PORT"),
    ({"ITR_SMTP_TLS": "none"}, "ITR_SMTP_TLS"),
    ({"ITR_SMTP_PASSWORD": ""}, "ITR_SMTP_PASSWORD"),
])
def test_incomplete_or_invalid_configuration_fails_without_echoing_values(changes, variable):
    with pytest.raises(SmtpConfigError) as exc:
        SmtpConfig.from_env({**ENV, **changes})
    assert variable in str(exc.value) and PASSWORD not in str(exc.value)


def test_the_password_never_appears_in_reprs():
    settings = Settings(environment="production", allowed_origins=(PROD_ORIGIN,), public_base_url=PROD_ORIGIN,
                        smtp=CONFIG)
    assert all(PASSWORD not in repr(x) for x in (CONFIG, settings, SmtpSender(CONFIG)))


def test_development_stays_simulated_even_with_smtp():
    assert Settings(environment="development", smtp=CONFIG).email_delivery == "simulated"


# === sending ============================================================================================================

def test_starttls_login_and_send(fake_smtp):
    outcome = SmtpSender(CONFIG).send(message())
    (server,) = fake_smtp.instances
    assert server.steps == ["starttls", "login", "send", "quit"]
    assert server.credentials == ("synthetic-user", PASSWORD)
    (mime,) = server.sent
    assert (mime["From"], mime["To"], mime["Subject"]) == ("no-reply@example.test", "jane.synthetic@example.test",
                                                           "Continue your ITR Intake")
    assert SECRET in mime.get_content()
    assert outcome.simulated is False and outcome.provider_message_id == mime["Message-ID"]


def test_implicit_tls_uses_a_verified_tls_connection(fake_smtp):
    config = SmtpConfig(host="smtp.example.test", from_address="no-reply@example.test", port=465, tls="implicit")
    SmtpSender(config).send(message())
    (server,) = fake_smtp.instances
    assert server.steps == ["send", "quit"] and server.implicit_context.verify_mode == ssl.CERT_REQUIRED


@pytest.mark.parametrize("step, error, code, retryable", [
    ("send", smtplib.SMTPRecipientsRefused({"x@example.test": (550, b"no such user")}), "recipient_refused", False),
    ("send", smtplib.SMTPDataError(554, b"provider text"), "rejected", False),
    ("send", smtplib.SMTPDataError(451, b"try later"), "temporary_failure", True),
    ("login", smtplib.SMTPAuthenticationError(535, b"bad credentials"), "auth_failed", True),
    ("starttls", smtplib.SMTPNotSupportedError("no STARTTLS"), "tls_unavailable", True),
    ("starttls", ssl.SSLError("certificate verify failed"), "tls_failed", True),
    ("connect", ConnectionRefusedError("refused"), "connection_failed", True),
    ("send", smtplib.SMTPServerDisconnected("gone"), "connection_failed", True),
])
def test_failures_become_fixed_codes(fake_smtp, step, error, code, retryable):
    fake_smtp.fail = {step: error}
    with pytest.raises(emails.EmailSendError) as exc:
        SmtpSender(CONFIG).send(message())
    assert (exc.value.code, exc.value.retryable) == (code, retryable)


def test_a_header_with_a_line_break_is_never_sent(fake_smtp):
    with pytest.raises(emails.EmailSendError) as exc:
        SmtpSender(CONFIG).send(message(to="jane@example.test\r\nBcc: other@example.test"))
    assert (exc.value.code, exc.value.retryable) == ("invalid_message", False)
    assert all(not s.sent for s in fake_smtp.instances)


# === production queueing ===============================================================================================

def smtp_prod_app(tmp_path):
    return create_app(Settings(environment="production", database_path=tmp_path / "prod.db",
                               allowed_origins=(PROD_ORIGIN,), public_base_url=PROD_ORIGIN, smtp=CONFIG))


def test_production_with_smtp_queues_sign_in_and_verification_mail(tmp_path):
    app = smtp_prod_app(tmp_path)
    with new_client(app, base_url="https://testserver", client=("203.0.113.10", 443)) as c:
        reg = c.post("/api/ca/register", json={"full_name": "CA (synthetic)", "email": "ca-p@example.test",
                                               "password": "a-synthetic-pass-8812", "firm_name": "Firm (synthetic)"},
                     headers=PH)
        assert reg.status_code == 202 and reg.json() == {"status": "verification_required", "email_delivery": "email"}
        reset = c.post("/api/ca/request-password-reset", json={"email": "nobody@example.test"}, headers=PH)
        assert reset.json() == {"status": "reset_requested", "email_delivery": "email"}  # no dev outbox link
    rows = db_rows(tmp_path / "prod.db", "SELECT template, recipient, status, body_text FROM email_outbox")
    assert [(t, r, s) for t, r, s, _ in rows] == [(emails.TEMPLATE_VERIFY_EMAIL, "ca-p@example.test", "pending")]
    assert f"{PROD_ORIGIN}/ca/verify-email#token=" in rows[0][3]
    assert db_rows(tmp_path / "prod.db", "SELECT count(*) FROM dev_mailbox")[0][0] == 0


# === the worker in production ============================================================================================

def test_production_worker_sends_over_smtp(tmp_path, monkeypatch, fake_smtp, capsys):
    path = tmp_path / "email.db"
    conn = initialize_database(path)
    entry = queue(conn, now=datetime.now(UTC))
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)
    assert email_worker.main(["--once", "--db", str(path)]) == 0
    stored = row(conn, entry["id"])
    conn.close()
    assert stored["status"] == "sent" and stored["body_text"] is None and stored["provider_message_id"]
    (server,) = fake_smtp.instances
    assert server.sent[0]["To"] == stored["recipient"]
    output = capsys.readouterr()
    assert "sent=1" in output.out and "smtp.example.test" in output.out
    assert all(s not in output.out + output.err for s in (SECRET, PASSWORD, "https://"))


def test_production_worker_refuses_an_invalid_configuration(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("ITR_SMTP_HOST", "smtp.example.test")
    assert email_worker.main(["--once", "--db", str(tmp_path / "e.db")]) == 2
    assert "ITR_EMAIL_FROM" in capsys.readouterr().err
    assert not (tmp_path / "e.db").exists()
