"""CA authentication over HTTP (FastAPI app). In-process test client,
temporary databases and synthetic accounts only; no network, no e-mail."""

import sqlite3
import warnings

import pytest

# Starlette 1.x warns at import that its test client prefers `httpx2`; adding
# that dependency is out of scope, so this one known message is silenced.
with warnings.catch_warnings():
    warnings.filterwarnings("ignore", message="Using `httpx` with `starlette.testclient`")
    from fastapi.testclient import TestClient

import itr_intake_server.ca_auth as auth
import itr_intake_server.repository as repo
from itr_intake_server import admin
from itr_intake_server import email_service as emails
from itr_intake_server import email_worker
from itr_intake_server.__main__ import main as server_main
from itr_intake_server.app import create_app
from itr_intake_server.db import DEFAULT_DATABASE_PATH, connect
from itr_intake_server.settings import Settings

PASSWORD = "synthetic-pass-9481"
DEV_ORIGIN = "http://localhost:3000"
PROD_ORIGIN = "https://app.example.test"
H = {"Origin": DEV_ORIGIN, "X-ITR-Request": "1"}


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
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as c:
        yield c


def new_client(app, **kw):
    return TestClient(app, base_url=kw.pop("base_url", "http://localhost"), client=kw.pop("client", ("127.0.0.1", 50000)),
                      **kw)


def register(client, tag="a", **extra):
    body = {"full_name": f"CA {tag} (synthetic)", "email": f"ca-{tag}@example.test", "password": PASSWORD,
            "firm_name": f"Firm {tag} (synthetic)", **extra}
    return client.post("/api/ca/register", json=body, headers=H)


def deliver(app):
    """Run the e-mail worker once, as the separate worker process would."""
    sender = emails.SimulatedSender(app.state.dev_outbox, development=True)
    return email_worker.run_once(app.state.settings.database_path, sender)


def messages(app):
    deliver(app)
    return app.state.dev_outbox.messages()


def outbox_token(app, email):
    message = next(m for m in messages(app) if m.to == email)
    return message.link.split("#token=")[1]


def verify(client, app, tag="a"):
    return client.post("/api/ca/verify-email", json={"token": outbox_token(app, f"ca-{tag}@example.test")}, headers=H)


def approve(db_path, tag="a"):
    conn = connect(db_path)
    try:
        return admin.approve(conn, f"ca-{tag}@example.test", "operator")
    finally:
        conn.close()


def login(client, tag="a", password=PASSWORD):
    return client.post("/api/ca/login", json={"email": f"ca-{tag}@example.test", "password": password}, headers=H)


def onboard(client, app, db_path, tag="a"):
    assert register(client, tag).status_code == 202
    assert verify(client, app, tag).status_code == 200
    assert approve(db_path, tag).startswith("Approved")


def cookie_header(response):
    return response.headers.get("set-cookie", "")


def db_rows(db_path, sql, params=()):
    conn = connect(db_path)
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


# === startup ======================================================================================

def test_startup_initialises_the_database_in_the_given_directory(db_path):
    from conftest import var_dir_state
    real_before = var_dir_state()
    assert not db_path.exists() and db_path != DEFAULT_DATABASE_PATH
    create_app(Settings(environment="development", database_path=db_path))
    assert db_path.exists()
    tables = {r[0] for r in db_rows(db_path, "SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"firms", "ca_users", "sessions", "schema_migrations"} <= tables
    create_app(Settings(environment="development", database_path=db_path))  # restart is idempotent
    assert db_rows(db_path, "SELECT count(*) FROM schema_migrations")[0][0] == 6
    assert var_dir_state() == real_before  # the real local database was not touched


def test_production_settings_require_https_origins():
    with pytest.raises(ValueError):
        Settings(environment="production")
    with pytest.raises(ValueError):
        Settings(environment="production", allowed_origins=("http://app.example.test",), public_base_url="https://x")
    with pytest.raises(ValueError):
        Settings(environment="staging")
    assert Settings(environment="development").allowed_origins == ("http://localhost:3000", "http://127.0.0.1:3000")


def test_server_never_trusts_forwarding_headers(monkeypatch, tmp_path):
    import itr_intake_server.__main__ as entry

    captured = {}
    monkeypatch.setenv("ITR_DB_PATH", str(tmp_path / "entry.db"))
    monkeypatch.setattr(entry.uvicorn, "run", lambda app, **kw: captured.update(kw))
    assert server_main(["--dev"]) == 0
    assert captured["proxy_headers"] is False and captured["host"] == "127.0.0.1"


def test_dev_server_refuses_non_loopback_hosts(capsys):
    assert server_main(["--dev", "--host", "0.0.0.0"]) == 2
    assert "only listens on 127.0.0.1" in capsys.readouterr().err


# === registration, simulation and approval ===============================================================

def test_registration_simulates_email_without_leaking_the_token(client, app, db_path):
    response = register(client)
    assert response.status_code == 202
    assert response.json() == {"status": "verification_required", "email_delivery": "simulated",
                               "dev_outbox_url": "http://127.0.0.1:8000/dev/outbox"}
    token = outbox_token(app, "ca-a@example.test")
    assert token not in response.text and token not in str(response.headers)
    message = app.state.dev_outbox.messages()[0]
    assert "was not sent" in message.body and token not in repr(message)
    secret = token.split(".")[1]
    # After simulated delivery the queue row holds no link; only the dev-only inbox does.
    outbox_row = db_rows(db_path, "SELECT status, body_text FROM email_outbox")[0]
    assert tuple(outbox_row) == ("simulated", None)
    for (table,) in db_rows(db_path, "SELECT name FROM sqlite_master WHERE type = 'table'"):
        for row in db_rows(db_path, f"SELECT * FROM {table}"):
            holds = any(isinstance(v, str) and (secret in v or PASSWORD in v) for v in row)
            assert holds == (table == "dev_mailbox"), table
    assert db_rows(db_path, "SELECT status FROM firms")[0][0] == "pending_verification"


def test_verification_does_not_approve(client, app, db_path):
    register(client)
    assert login(client).status_code == 401  # unverified
    assert verify(client, app).json() == {"status": "email_verified", "next": "awaiting_approval"}
    assert db_rows(db_path, "SELECT status FROM firms")[0][0] == "pending_approval"
    assert login(client).status_code == 401  # verified but not approved
    assert verify(client, app).status_code == 400  # verification links are single-use


def test_login_works_only_after_cli_approval(client, app, db_path, capsys):
    register(client)
    verify(client, app)
    assert admin.main(["--db", str(db_path), "list-pending"]) == 0
    listing = capsys.readouterr().out
    assert "ca-a@example.test" in listing and "scrypt$" not in listing
    assert admin.main(["--db", str(db_path), "approve", "--email", "ca-a@example.test", "--approved-by", "operator"]) == 0
    assert "Approved" in capsys.readouterr().out
    assert login(client).status_code == 200


def test_cli_refuses_to_approve_an_unverified_email(client, db_path, capsys):
    register(client)
    assert admin.main(["--db", str(db_path), "approve", "--email", "ca-a@example.test", "--approved-by", "op"]) == 1
    assert "not been verified" in capsys.readouterr().out
    assert admin.main(["--db", str(db_path), "approve", "--email", "nobody@example.test", "--approved-by", "op"]) == 1


def test_there_is_no_http_admin_or_approval_route(app):
    paths = {r.path for r in app.routes}
    assert not any("admin" in p or "approve" in p for p in paths)


def test_duplicate_registration_looks_like_a_new_one(client, app):
    first = register(client)
    before = len(messages(app))
    second = register(client, "b", email="CA-A@example.test")
    assert second.status_code == first.status_code == 202 and second.json() == first.json()
    assert len(messages(app)) == before  # no message for the duplicate


def test_weak_password_is_reported_with_a_safe_code(client):
    response = register(client, password="short")
    assert response.status_code == 400 and response.json()["code"] == "password_too_short"
    assert "short" not in response.text.replace("password_too_short", "")


def test_resend_verification_supersedes_and_is_generic(client, app):
    register(client)
    old = outbox_token(app, "ca-a@example.test")
    known = client.post("/api/ca/resend-verification", json={"email": "ca-a@example.test"}, headers=H)
    unknown = client.post("/api/ca/resend-verification", json={"email": "nobody@example.test"}, headers=H)
    assert known.status_code == unknown.status_code == 202 and known.json() == unknown.json()
    new = outbox_token(app, "ca-a@example.test")
    assert new != old
    assert client.post("/api/ca/verify-email", json={"token": old}, headers=H).status_code == 400
    assert client.post("/api/ca/verify-email", json={"token": new}, headers=H).status_code == 200


# === login cookie ============================================================================================

def test_login_sets_an_httponly_cookie_and_never_returns_the_token(client, app, db_path):
    onboard(client, app, db_path)
    response = login(client)
    assert response.status_code == 200 and response.json() == {"status": "signed_in"}
    header = cookie_header(response)
    name, _, rest = header.partition("=")
    token = rest.split(";", 1)[0]
    attributes = [a.strip().lower() for a in header.split(";")[1:]]
    assert name == "itr_ca_session" and len(token) == 43
    assert "httponly" in attributes and "samesite=lax" in attributes and "path=/" in attributes
    assert "max-age=43200" in attributes and "secure" not in attributes  # plain http in development
    assert token not in response.text
    me = client.get("/api/ca/me")
    assert me.status_code == 200 and token not in me.text
    assert me.json()["firm"] == {"name": "Firm a (synthetic)", "status": "active"}
    assert set(me.json()) == {"user", "firm", "session"}


def test_login_rotates_the_session(client, app, db_path):
    onboard(client, app, db_path)
    login(client)
    login(client)  # the browser presents its existing cookie
    assert db_rows(db_path, "SELECT count(*) FROM sessions WHERE revoked_at IS NULL")[0][0] == 1


def prod_app(tmp_path):
    return create_app(Settings(environment="production", database_path=tmp_path / "prod.db",
                               allowed_origins=(PROD_ORIGIN,), public_base_url=PROD_ORIGIN))


def test_production_uses_secure_host_prefixed_cookies(tmp_path):
    app = prod_app(tmp_path)
    ph = {"Origin": PROD_ORIGIN, "X-ITR-Request": "1"}
    with new_client(app, base_url="https://testserver", client=("203.0.113.10", 443)) as c:
        reg = c.post("/api/ca/register", json={"full_name": "Prod CA", "email": "prod@example.test", "password": PASSWORD,
                                               "firm_name": "Prod Firm (synthetic)"}, headers=ph)
        assert reg.json() == {"status": "verification_required", "email_delivery": "not_configured"}
        conn = connect(tmp_path / "prod.db")
        user = repo.get_ca_user_for_login(conn, "prod@example.test")
        auth.confirm_email(conn, auth.start_email_verification(conn, user["id"]))
        admin.approve(conn, "prod@example.test", "operator")
        conn.close()
        response = c.post("/api/ca/login", json={"email": "prod@example.test", "password": PASSWORD}, headers=ph)
        header = cookie_header(response).lower()
        assert header.startswith("__host-itr_ca_session=") and "; secure" in header and "httponly" in header
        assert c.get("/api/ca/me").status_code == 200


# === sessions on protected requests ===========================================================================

def test_missing_and_invalid_sessions_are_rejected(client, app, db_path):
    onboard(client, app, db_path)
    assert client.get("/api/ca/me").status_code == 401  # no cookie
    for bad in ("garbage", "x" * 43, "' OR 1=1 --"):
        client.cookies.set("itr_ca_session", bad)
        response = client.get("/api/ca/me")
        assert response.status_code == 401 and response.json()["error"] == "unauthenticated"
        assert "itr_ca_session=" in cookie_header(response) and "max-age=0" in cookie_header(response).lower()
        client.cookies.clear()


@pytest.mark.parametrize("column", ["idle_expires_at", "absolute_expires_at"])
def test_expired_sessions_are_rejected(client, app, db_path, column):
    onboard(client, app, db_path)
    login(client)
    conn = connect(db_path)
    conn.execute(f"UPDATE sessions SET {column} = '2000-01-01T00:00:00.000000Z'")
    conn.close()
    assert client.get("/api/ca/me").status_code == 401
    assert client.get("/api/ca/cases").status_code == 401


def test_logout_revokes_the_session(client, app, db_path):
    onboard(client, app, db_path)
    token = cookie_header(login(client)).split("=", 1)[1].split(";", 1)[0]
    assert client.get("/api/ca/cases").status_code == 200
    out = client.post("/api/ca/logout", headers=H)
    assert out.json() == {"status": "signed_out"} and "max-age=0" in cookie_header(out).lower()
    assert client.get("/api/ca/me").status_code == 401
    client.cookies.set("itr_ca_session", token)  # replaying the old cookie
    assert client.get("/api/ca/cases").status_code == 401
    assert db_rows(db_path, "SELECT count(*) FROM sessions WHERE revoked_at IS NULL")[0][0] == 0


def test_deactivated_account_loses_access_immediately(client, app, db_path):
    onboard(client, app, db_path)
    login(client)
    conn = connect(db_path)
    user = repo.get_ca_user_for_login(conn, "ca-a@example.test")
    auth.admin_deactivate_ca_user(conn, firm_id=user["firm_id"], user_id=user["id"])
    conn.close()
    assert client.get("/api/ca/me").status_code == 401


# === CSRF and origin ===============================================================================================

@pytest.mark.parametrize("headers", [
    {},  # no Origin, no CSRF header
    {"X-ITR-Request": "1"},  # no Origin
    {"Origin": DEV_ORIGIN},  # no CSRF header
    {"Origin": "https://evil.example.test", "X-ITR-Request": "1"},
    {"Origin": "null", "X-ITR-Request": "1"},
    {"Origin": DEV_ORIGIN, "X-ITR-Request": "true"},
])
def test_state_changing_requests_need_origin_and_csrf_header(client, app, db_path, headers):
    onboard(client, app, db_path)
    for path, body in (("/api/ca/login", {"email": "ca-a@example.test", "password": PASSWORD}),
                       ("/api/ca/register", {"full_name": "X", "email": "x@example.test", "password": PASSWORD,
                                             "firm_name": "X"}),
                       ("/api/ca/logout", None)):
        response = client.post(path, json=body, headers=headers)
        assert response.status_code == 403 and response.json() == {"error": "forbidden", "message": "Request not allowed."}
        assert "set-cookie" not in response.headers


def test_no_cors_access_for_other_origins(client):
    response = client.get("/api/ca/me", headers={"Origin": "https://evil.example.test"})
    assert "access-control-allow-origin" not in response.headers
    preflight = client.options("/api/ca/login", headers={"Origin": "https://evil.example.test",
                                                         "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in preflight.headers


def test_security_headers(client):
    response = client.get("/api/ca/me")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"


# === development outbox ==============================================================================================

def test_dev_outbox_works_for_direct_loopback_requests(client, app):
    register(client)
    assert "waiting for the email worker" in client.get("/dev/outbox").text  # queued, not yet delivered
    deliver(app)
    page = client.get("/dev/outbox")
    assert page.status_code == 200 and "No email was sent" in page.text and "/ca/verify-email#token=" in page.text
    assert page.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("kw, headers", [
    ({"client": ("203.0.113.7", 50000)}, {}),  # remote client
    ({}, {"X-Forwarded-For": "203.0.113.7"}),  # arrived through a proxy (e.g. the Next.js rewrite)
    ({}, {"Forwarded": "for=203.0.113.7"}),
    ({"base_url": "http://itr.example.test"}, {}),  # non-loopback Host header
])
def test_dev_outbox_refuses_non_local_access(app, kw, headers):
    with new_client(app, **kw) as c:
        assert c.get("/dev/outbox", headers=headers).status_code == 404


def test_dev_outbox_does_not_exist_in_production(tmp_path):
    app = prod_app(tmp_path)
    assert app.state.dev_outbox is None
    assert not any(getattr(r, "path", "").startswith("/dev") for r in app.routes)
    with new_client(app, base_url="https://localhost", client=("127.0.0.1", 1)) as c:
        assert c.get("/dev/outbox").status_code == 404


# === firm isolation and generic errors =================================================================================

def test_each_ca_sees_only_their_own_firm(app, db_path):
    a_client, b_client = new_client(app), new_client(app)
    onboard(a_client, app, db_path, "a")
    onboard(b_client, app, db_path, "b")
    conn = connect(db_path)
    refs = {}
    for tag in ("a", "b"):
        user = repo.get_ca_user_for_login(conn, f"ca-{tag}@example.test")
        scope = repo.FirmScope(user["firm_id"])
        client_identity = repo.get_or_create_client_identity(conn, scope, f"client-{tag}@example.test")
        refs[tag] = repo.create_case(conn, scope, client_identity_id=client_identity["id"], first_name=f"Demo{tag}",
                                     financial_year="2025-26")["reference"]
    b_firm = repo.get_ca_user_for_login(conn, "ca-b@example.test")["firm_id"]
    conn.close()
    login(a_client, "a"), login(b_client, "b")
    a_cases = a_client.get("/api/ca/cases", params={"firm_id": b_firm}).json()["cases"]  # browser firm_id is ignored
    assert [c["reference"] for c in a_cases] == [refs["a"]]
    assert [c["reference"] for c in b_client.get("/api/ca/cases").json()["cases"]] == [refs["b"]]
    assert a_client.get("/api/ca/me").json()["firm"]["name"] == "Firm a (synthetic)"
    assert "firm_id" not in a_client.get("/api/ca/me").text
    a_client.close(), b_client.close()


def test_login_failures_are_generic(client, app, db_path):
    onboard(client, app, db_path, "a")
    register(client, "pending")
    responses = [
        login(client, "a", password="wrong-password-123"),
        client.post("/api/ca/login", json={"email": "nobody@example.test", "password": PASSWORD}, headers=H),
        login(client, "pending"),
    ]
    assert {r.status_code for r in responses} == {401}
    assert len({r.text for r in responses}) == 1
    assert responses[0].json() == {"error": "invalid_credentials", "message": "Invalid email or password."}


def test_validation_errors_do_not_echo_input(client):
    response = client.post("/api/ca/login", json={"email": "ca@example.test", "password": 12345678901234,
                                                  "extra": "secret-value-xyz"}, headers=H)
    assert response.status_code == 422
    assert response.json()["error"] == "invalid_request"
    assert "12345678901234" not in response.text and "secret-value-xyz" not in response.text


def test_unexpected_errors_are_generic(app, db_path, monkeypatch):
    def boom(*args, **kwargs):
        raise sqlite3.OperationalError("no such table: SELECT password_hash FROM ca_users")

    monkeypatch.setattr(auth, "login_ca", boom)
    with new_client(app, raise_server_exceptions=False) as c:
        response = c.post("/api/ca/login", json={"email": "ca@example.test", "password": PASSWORD}, headers=H)
    assert response.status_code == 500
    assert response.json() == {"error": "internal_error", "message": "Something went wrong."}
    assert "password_hash" not in response.text and "Traceback" not in response.text
