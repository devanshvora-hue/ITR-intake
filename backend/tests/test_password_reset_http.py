"""Password-reset HTTP routes: generic answers, queued simulated e-mail,
single-use links, session revocation, CSRF/origin checks and abuse limits.
In-process client, temporary databases, synthetic accounts, no network."""

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.ca_auth as auth
from itr_intake_server.app import create_app
from itr_intake_server.settings import Settings
from test_server_app import (  # noqa: F401  (helpers shared with the other HTTP tests)
    DEV_ORIGIN,
    H,
    PASSWORD,
    PROD_ORIGIN,
    db_rows,
    deliver,
    login,
    messages,
    new_client,
    onboard,
    prod_app,
    register,
)

NEW_PASSWORD = "another-synthetic-pass-7734"
ASK = "/api/ca/request-password-reset"
CONFIRM = "/api/ca/reset-password"


@pytest.fixture(autouse=True)
def fast_scrypt(monkeypatch):
    monkeypatch.setattr(auth, "SCRYPT_N", 2**10)


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "var" / "app.db"


@pytest.fixture
def app(db_path):
    return create_app(Settings(environment="development", database_path=db_path))


@pytest.fixture
def client(app):
    with new_client(app) as c:
        yield c


def ask(client, email="ca-a@example.test", headers=H):
    return client.post(ASK, json={"email": email}, headers=headers)


def reset_token(app, email="ca-a@example.test"):
    mail = next(m for m in messages(app) if m.to == email and "reset" in m.subject.lower())
    assert "/ca/reset-password#token=" in mail.link
    return mail.link.split("#token=")[1]


def reset_rows(db_path):
    rows = db_rows(db_path, "SELECT status, body_text FROM email_outbox WHERE template = 'ca_password_reset'")
    return [tuple(r) for r in rows]


# === generic answers ====================================================================================

def test_answers_are_identical_for_known_unknown_and_malformed_emails(client, app, db_path):
    onboard(client, app, db_path)
    known, unknown, malformed = ask(client), ask(client, "nobody@example.test"), ask(client, "not an email")
    assert known.status_code == unknown.status_code == malformed.status_code == 202
    assert known.json() == unknown.json() == malformed.json() == {
        "status": "reset_requested", "email_delivery": "simulated", "dev_outbox_url": "http://127.0.0.1:8000/dev/outbox"}
    assert known.text == unknown.text == malformed.text
    deliver(app)
    recipients = {r[0] for r in db_rows(db_path, "SELECT recipient FROM email_outbox WHERE template = 'ca_password_reset'")}
    assert recipients == {"ca-a@example.test"}  # only the real account got a message


def test_the_request_queues_mail_and_the_worker_delivers_it(client, app, db_path):
    onboard(client, app, db_path)
    ask(client)
    assert reset_rows(db_path) == [("pending", reset_rows(db_path)[0][1])] and reset_rows(db_path)[0][1]  # waiting
    token = reset_token(app)  # runs the worker
    assert reset_rows(db_path) == [("simulated", None)]  # delivered, body cleared
    assert token not in str(ask(client).headers)


def test_reset_secret_lives_only_where_it_must(client, app, db_path):
    onboard(client, app, db_path)
    response = ask(client)
    token = reset_token(app)
    secret = token.split(".")[1]
    assert token not in response.text
    for (table,) in db_rows(db_path, "SELECT name FROM sqlite_master WHERE type = 'table'"):
        holds = any(isinstance(v, str) and secret in v for row in db_rows(db_path, f"SELECT * FROM {table}") for v in row)
        assert holds == (table == "dev_mailbox"), table  # no other table, nor the queue, keeps the link


# === the reset itself ====================================================================================

def test_reset_changes_the_password_and_ends_every_session(client, app, db_path):
    onboard(client, app, db_path)
    assert login(client).status_code == 200 and client.get("/api/ca/me").status_code == 200
    ask(client)
    response = client.post(CONFIRM, json={"token": reset_token(app), "new_password": NEW_PASSWORD}, headers=H)
    assert response.status_code == 200 and response.json() == {"status": "password_reset"}
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert client.get("/api/ca/me").status_code == 401  # the old session is gone
    assert login(client, password=PASSWORD).status_code == 401
    assert login(client, password=NEW_PASSWORD).status_code == 200


def test_a_reset_link_works_once(client, app, db_path):
    onboard(client, app, db_path)
    ask(client)
    token = reset_token(app)
    assert client.post(CONFIRM, json={"token": token, "new_password": NEW_PASSWORD}, headers=H).status_code == 200
    again = client.post(CONFIRM, json={"token": token, "new_password": "yet-another-pass-5521"}, headers=H)
    assert again.status_code == 400 and again.json()["error"] == "reset_failed"
    assert login(client, password=NEW_PASSWORD).status_code == 200


def test_a_newer_link_replaces_the_older_one(client, app, db_path):
    onboard(client, app, db_path)
    ask(client)
    old = reset_token(app)
    ask(client)
    new = [m for m in messages(app) if m.to == "ca-a@example.test" and "reset" in m.subject.lower()][0].link.split("#token=")[1]
    assert new != old
    assert client.post(CONFIRM, json={"token": old, "new_password": NEW_PASSWORD}, headers=H).status_code == 400
    assert client.post(CONFIRM, json={"token": new, "new_password": NEW_PASSWORD}, headers=H).status_code == 200


def test_a_weak_password_is_refused_and_the_link_survives(client, app, db_path):
    onboard(client, app, db_path)
    ask(client)
    token = reset_token(app)
    weak = client.post(CONFIRM, json={"token": token, "new_password": "short"}, headers=H)
    assert weak.status_code == 400 and weak.json()["error"] == "invalid_password"
    assert weak.json()["code"] == "password_too_short" and "short" not in weak.text.replace("password_too_short", "")
    assert client.post(CONFIRM, json={"token": token, "new_password": NEW_PASSWORD}, headers=H).status_code == 200


@pytest.mark.parametrize("token", ["", "garbage", "x" * 43, "11111111-1111-4111-8111-111111111111." + "A" * 43, "' OR 1=1 --"])
def test_bad_tokens_get_one_generic_answer(client, token):
    response = client.post(CONFIRM, json={"token": token, "new_password": NEW_PASSWORD}, headers=H)
    assert response.status_code == 400
    assert response.json() == {"error": "reset_failed", "message": "This reset link is invalid or has expired."}


def test_a_verification_link_cannot_reset_a_password(client, app, db_path):
    register(client)
    verification = next(m for m in messages(app) if m.to == "ca-a@example.test").link.split("#token=")[1]
    assert client.post(CONFIRM, json={"token": verification, "new_password": NEW_PASSWORD}, headers=H).status_code == 400


# === origin and CSRF ===================================================================================

@pytest.mark.parametrize("headers", [{}, {"X-ITR-Request": "1"}, {"Origin": DEV_ORIGIN},
                                     {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}])
def test_both_routes_need_origin_and_csrf_header(client, app, db_path, headers):
    onboard(client, app, db_path)
    for path, body in ((ASK, {"email": "ca-a@example.test"}), (CONFIRM, {"token": "t", "new_password": NEW_PASSWORD})):
        response = client.post(path, json=body, headers=headers)
        assert response.status_code == 403 and response.json() == {"error": "forbidden", "message": "Request not allowed."}
    assert reset_rows(db_path) == []  # nothing was queued


def test_validation_errors_do_not_echo_input(client):
    response = client.post(CONFIRM, json={"token": "t", "new_password": 12345678901234, "extra": "secret-value-xyz"},
                           headers=H)
    assert response.status_code == 422 and "secret-value-xyz" not in response.text and "12345678901234" not in response.text


# === abuse controls ====================================================================================

def test_one_address_gets_a_few_reset_messages_per_hour_with_an_unchanged_answer(client, app, db_path):
    onboard(client, app, db_path)
    answers = {ask(client).text for _ in range(app_module.RESET_REQUESTS_PER_EMAIL + 3)}
    assert len(answers) == 1  # the limit is invisible to the caller
    assert len(reset_rows(db_path)) == app_module.RESET_REQUESTS_PER_EMAIL
    assert ask(client, "CA-A@Example.test ").status_code == 202  # case and spaces do not give a fresh allowance
    assert len(reset_rows(db_path)) == app_module.RESET_REQUESTS_PER_EMAIL


def test_a_forged_forwarded_for_header_does_not_buy_a_new_allowance(client, app, db_path, monkeypatch):
    monkeypatch.setattr(app_module, "RESET_REQUESTS_PER_PEER", 2)
    for tag in "abc":
        register(client, tag)
    for i, tag in enumerate("abc"):
        spoof = {**H, "X-Forwarded-For": f"203.0.113.{i + 1}", "X-Real-IP": f"198.51.100.{i + 1}"}
        assert ask(client, f"ca-{tag}@example.test", headers=spoof).status_code == 202
    queued = {r[0] for r in db_rows(db_path, "SELECT recipient FROM email_outbox WHERE template = 'ca_password_reset'")}
    assert queued == {"ca-a@example.test", "ca-b@example.test"}  # the third request shared the connected peer's bucket


def test_a_different_connected_peer_has_its_own_bucket(app, db_path, monkeypatch):
    monkeypatch.setattr(app_module, "RESET_REQUESTS_PER_PEER", 1)
    with new_client(app) as first, new_client(app, client=("127.0.0.2", 50000)) as second:
        register(first, "a"), register(first, "b")
        ask(first, "ca-a@example.test")
        ask(second, "ca-b@example.test")
    assert len(reset_rows(db_path)) == 2


def test_confirmation_attempts_are_limited_per_peer(client, monkeypatch):
    monkeypatch.setattr(app_module, "RESET_ATTEMPTS_PER_PEER", 2)
    body = {"token": "garbage", "new_password": NEW_PASSWORD}
    assert [client.post(CONFIRM, json=body, headers=H).status_code for _ in range(4)] == [400, 400, 429, 429]
    assert client.post(CONFIRM, json=body, headers=H).json() == {"error": "rate_limited",
                                                                  "message": "Too many attempts. Please try again later."}


def test_counters_hold_hashes_only(client, app, db_path):
    onboard(client, app, db_path)
    ask(client)
    client.post(CONFIRM, json={"token": "garbage", "new_password": NEW_PASSWORD}, headers=H)
    buckets = [r[0] for r in db_rows(db_path, "SELECT bucket FROM rate_limits")]
    assert buckets and all(b.split(":", 1)[0].startswith("reset-") for b in buckets)
    assert not any("example.test" in b or "127.0.0.1" in b for b in buckets)


# === production ========================================================================================

def test_production_reports_not_configured_and_queues_nothing(tmp_path):
    app = prod_app(tmp_path)
    ph = {"Origin": PROD_ORIGIN, "X-ITR-Request": "1"}
    with new_client(app, base_url="https://testserver", client=("203.0.113.10", 443)) as c:
        response = c.post(ASK, json={"email": "anyone@example.test"}, headers=ph)
        assert response.status_code == 202
        assert response.json() == {"status": "reset_requested", "email_delivery": "not_configured"}
        assert c.post(CONFIRM, json={"token": "garbage", "new_password": NEW_PASSWORD}, headers=ph).status_code == 400
    db = tmp_path / "prod.db"
    assert db_rows(db, "SELECT count(*) FROM email_outbox")[0][0] == 0
    assert db_rows(db, "SELECT count(*) FROM verification_challenges")[0][0] == 0
