"""Client onboarding (Stage 5.6): firm code + e-mail, verification links,
client sessions, case creation, isolation, CSRF, abuse limits and safe errors.
In-process clients, temporary databases and synthetic accounts only."""

import logging
import sqlite3
from datetime import date, timedelta

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.ca_auth as auth
import itr_intake_server.client_auth as client_auth
import itr_intake_server.repository as repo
from itr_intake_server.app import create_app
from itr_intake_server.db import connect
from itr_intake_server.settings import Settings
from test_server_app import (
    DEV_ORIGIN,
    H,
    PROD_ORIGIN,
    db_rows,
    deliver,
    login,
    messages,
    new_client,
    onboard,
    prod_app,
)

CLIENT_EMAIL = "client-one@example.test"
FY = client_auth.financial_year_options()[1]  # the most recent completed financial year


@pytest.fixture(autouse=True)
def fast_scrypt(monkeypatch):
    monkeypatch.setattr(auth, "SCRYPT_N", 2**10)


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "var" / "app.db"


@pytest.fixture
def app(db_path):
    return create_app(Settings(environment="development", database_path=db_path))


def ca_with_code(app, db_path, tag="a"):
    """An approved, signed-in CA client and its firm's active code."""
    ca = new_client(app)
    onboard(ca, app, db_path, tag)
    assert login(ca, tag).status_code == 200
    code = ca.post("/api/ca/firm-code", headers=H).json()["firm_code"]
    return ca, code


@pytest.fixture
def firm(app, db_path):
    ca, code = ca_with_code(app, db_path)
    yield ca, code
    ca.close()


@pytest.fixture
def visitor(app):
    with new_client(app) as c:
        yield c


def start(client, code, email=CLIENT_EMAIL, headers=H):
    return client.post("/api/client/start", json={"firm_code": code, "email": email}, headers=headers)


def sign_in_link(app, email=CLIENT_EMAIL):
    links = [m.link for m in messages(app) if m.to == email and m.subject == "Continue your ITR Intake"]
    assert links, "no sign-in message"
    assert "/client/verify#token=" in links[0]
    return links[0].split("#token=")[1]


def verify(client, token, headers=H):
    return client.post("/api/client/verify", json={"token": token}, headers=headers)


def sign_in(client, app, code, email=CLIENT_EMAIL):
    assert start(client, code, email).status_code == 202
    response = verify(client, sign_in_link(app, email))
    assert response.status_code == 200, response.text
    return response


def open_case(client, financial_year=FY, first_name="Asha", headers=H):
    return client.post("/api/client/cases", json={"first_name": first_name, "financial_year": financial_year},
                       headers=headers)


CASE_KEYS = ("reference", "financial_year", "status", "created_at", "updated_at")


def core(case):
    """The Stage 5.6 case fields (later stages add profile and statements)."""
    return {k: case[k] for k in CASE_KEYS}


def client_sign_in_rows(db_path):
    return db_rows(db_path, "SELECT recipient FROM email_outbox WHERE template = 'client_sign_in'")


# === firm codes at the door ==============================================================================

def test_a_valid_code_sends_a_sign_in_link_and_the_answer_is_generic(app, db_path, firm, visitor):
    _, code = firm
    response = start(visitor, code["display"])
    assert response.status_code == 202
    assert response.json() == {"status": "check_email", "email_delivery": "simulated",
                               "dev_outbox_url": "http://127.0.0.1:8000/dev/outbox"}
    assert code["code"] not in response.text
    assert len(sign_in_link(app)) > 40


@pytest.mark.parametrize("bad", ["", "nonsense", "AAAA-BBBB-CCCC", "' OR 1=1 --", "x" * 64])
def test_invalid_codes_get_the_same_answer_and_no_email(app, db_path, firm, visitor, bad):
    _, code = firm
    good = start(visitor, code["code"], "someone-else@example.test")
    response = start(visitor, bad)
    assert response.status_code == good.status_code == 202 and response.text == good.text
    deliver(app)
    assert [r[0] for r in client_sign_in_rows(db_path)] == ["someone-else@example.test"]


def test_inputs_are_normalised(app, db_path, firm, visitor):
    _, code = firm
    start(visitor, f"  {code['display'].lower()} ", "  Client-One@Example.TEST ")
    assert [r[0] for r in client_sign_in_rows(db_path)] == [CLIENT_EMAIL]


def test_a_malformed_email_gets_the_same_answer(firm, visitor, db_path):
    _, code = firm
    assert start(visitor, code["code"], "not-an-email").text == start(visitor, "nonsense").text
    assert client_sign_in_rows(db_path) == []


def test_revoked_and_rotated_codes_are_refused(app, db_path, firm, visitor):
    ca, code = firm
    new = ca.post("/api/ca/firm-code/rotate", headers=H).json()["firm_code"]
    start(visitor, code["code"])  # the old code
    assert client_sign_in_rows(db_path) == []
    start(visitor, new["code"])
    assert len(client_sign_in_rows(db_path)) == 1
    ca.post("/api/ca/firm-code/revoke", headers=H)
    start(visitor, new["code"], "second@example.test")
    assert len(client_sign_in_rows(db_path)) == 1


def test_a_suspended_firms_code_is_refused(app, db_path, firm, visitor):
    _, code = firm
    conn = connect(db_path)
    auth.admin_suspend_firm(conn, firm_id=repo.find_active_firm_by_code(conn, code["code"])["firm_id"])
    conn.close()
    assert start(visitor, code["code"]).status_code == 202
    assert client_sign_in_rows(db_path) == []


def test_production_sends_nothing_and_says_so(tmp_path):
    app = prod_app(tmp_path)
    with new_client(app, base_url="https://testserver", client=("203.0.113.10", 443)) as c:
        response = c.post("/api/client/start", json={"firm_code": "AAAA-BBBB-CCCC", "email": CLIENT_EMAIL},
                          headers={"Origin": PROD_ORIGIN, "X-ITR-Request": "1"})
    assert response.json() == {"status": "check_email", "email_delivery": "not_configured"}
    assert db_rows(tmp_path / "prod.db", "SELECT count(*) FROM verification_challenges")[0][0] == 0


# === abuse limits ======================================================================================

def test_code_guessing_is_cut_off_per_peer_even_with_forged_headers(app, db_path, firm, visitor, monkeypatch):
    _, code = firm
    monkeypatch.setattr(app_module, "CLIENT_BAD_CODES_PER_PEER", 2)
    for i in range(2):
        start(visitor, f"WRONG{i}CODE{i}XX", headers={**H, "X-Forwarded-For": f"203.0.113.{i}"})
    answer = start(visitor, code["code"], headers={**H, "X-Forwarded-For": "198.51.100.1", "X-Real-IP": "198.51.100.2"})
    assert answer.status_code == 202 and answer.json()["status"] == "check_email"  # unchanged answer
    assert client_sign_in_rows(db_path) == []  # but no e-mail while the peer is cut off
    with new_client(app, client=("127.0.0.2", 50000)) as other_peer:
        start(other_peer, code["code"])
    assert len(client_sign_in_rows(db_path)) == 1


def test_sign_in_emails_are_limited_per_address(app, db_path, firm, visitor):
    _, code = firm
    answers = {start(visitor, code["code"]).text for _ in range(app_module.CLIENT_STARTS_PER_EMAIL + 2)}
    assert len(answers) == 1
    assert len(client_sign_in_rows(db_path)) == app_module.CLIENT_STARTS_PER_EMAIL


def test_verification_attempts_are_limited_per_peer(firm, visitor, monkeypatch):
    monkeypatch.setattr(app_module, "CLIENT_VERIFY_PER_PEER", 2)
    statuses = [verify(visitor, "garbage", headers={**H, "X-Forwarded-For": f"203.0.113.{i}"}).status_code
                for i in range(3)]
    assert statuses == [400, 400, 429]


def test_counters_hold_hashes_only(app, db_path, firm, visitor):
    _, code = firm
    start(visitor, code["code"])
    start(visitor, "WRONGCODE123")
    buckets = "".join(r[0] for r in db_rows(db_path, "SELECT bucket FROM rate_limits WHERE bucket LIKE 'client-%'"))
    assert buckets and CLIENT_EMAIL not in buckets and code["code"] not in buckets and "127.0.0.1" not in buckets


# === verification links ====================================================================================

def test_a_link_works_once(app, firm, visitor):
    _, code = firm
    start(visitor, code["code"])
    token = sign_in_link(app)
    assert verify(visitor, token).status_code == 200
    again = verify(visitor, token)
    assert again.status_code == 400
    assert again.json() == {"error": "verification_failed", "message": "This link is invalid or has expired. Please start again."}


def test_an_expired_link_is_refused(app, db_path, firm, visitor):
    _, code = firm
    start(visitor, code["code"])
    token = sign_in_link(app)
    conn = connect(db_path)
    conn.execute("UPDATE verification_challenges SET expires_at = '2000-01-01T00:00:00.000000Z' WHERE purpose = 'client_login'")
    conn.close()
    assert verify(visitor, token).status_code == 400


def test_wrong_secrets_use_up_the_attempts(app, firm, visitor):
    _, code = firm
    start(visitor, code["code"])
    token = sign_in_link(app)
    challenge_id = token.split(".")[0]
    for _ in range(client_auth.CLIENT_CHALLENGE_ATTEMPTS):
        assert verify(visitor, f"{challenge_id}.{'A' * 43}").status_code == 400
    assert verify(visitor, token).status_code == 400  # even the right secret is now refused


def test_a_new_link_replaces_the_old_one(app, db_path, firm, visitor):
    _, code = firm
    start(visitor, code["code"])
    old = sign_in_link(app)
    start(visitor, code["code"])
    new = sign_in_link(app)
    assert old != new
    assert verify(visitor, old).status_code == 400
    assert verify(visitor, new).status_code == 200


def test_a_link_stops_working_if_the_code_is_revoked_first(app, firm, visitor):
    ca, code = firm
    start(visitor, code["code"])
    token = sign_in_link(app)
    ca.post("/api/ca/firm-code/revoke", headers=H)
    assert verify(visitor, token).status_code == 400


def test_ca_links_cannot_sign_in_a_client(app, db_path, visitor):
    with new_client(app) as ca:
        ca.post("/api/ca/register", json={"full_name": "CA x (synthetic)", "email": "ca-x@example.test",
                                          "password": "synthetic-pass-9481", "firm_name": "Firm x"}, headers=H)
        ca_token = next(m for m in messages(app) if m.to == "ca-x@example.test").link.split("#token=")[1]
    assert verify(visitor, ca_token).status_code == 400


def test_secrets_are_not_in_responses_or_tables(app, db_path, firm, visitor):
    _, code = firm
    response = start(visitor, code["code"])
    token = sign_in_link(app)
    signed = verify(visitor, token)
    secret = token.split(".")[1]
    cookie = signed.cookies.get("itr_client_session")
    assert secret not in response.text and secret not in signed.text and cookie not in signed.text
    for (table,) in db_rows(db_path, "SELECT name FROM sqlite_master WHERE type = 'table'"):
        values = [v for row in db_rows(db_path, f"SELECT * FROM {table}") for v in row if isinstance(v, str)]
        assert not any(cookie in v for v in values), table
        assert any(secret in v for v in values) == (table == "dev_mailbox"), table


# === client sessions =======================================================================================

def test_session_cookie_attributes(app, firm, visitor):
    _, code = firm
    response = sign_in(visitor, app, code["code"])
    header = response.headers["set-cookie"]
    name, _, rest = header.partition("=")
    attributes = [a.strip().lower() for a in header.split(";")[1:]]
    assert name == "itr_client_session" and len(rest.split(";")[0]) == 43
    assert {"httponly", "samesite=lax", "path=/", "max-age=43200"} <= set(attributes)
    assert "secure" not in attributes  # plain http in development
    assert response.json() == {"status": "signed_in"}


def test_production_client_cookie_is_secure_and_host_prefixed(tmp_path):
    app = prod_app(tmp_path)
    conn = connect(tmp_path / "prod.db")
    firm = repo.create_firm(conn, name="Prod Firm (synthetic)")
    repo.admin_set_firm_status(conn, firm["id"], "active", approved_by="op")
    repo.create_firm_code(conn, repo.FirmScope(firm["id"]), "PROD2222CODE")
    token = client_auth.start_client_onboarding(conn, "PROD-2222-CODE", CLIENT_EMAIL).token
    conn.close()
    with new_client(app, base_url="https://testserver", client=("203.0.113.10", 443)) as c:
        response = c.post("/api/client/verify", json={"token": token}, headers={"Origin": PROD_ORIGIN, "X-ITR-Request": "1"})
        header = response.headers["set-cookie"].lower()
        assert header.startswith("__host-itr_client_session=") and "; secure" in header and "httponly" in header
        assert c.get("/api/client/me").status_code == 200


def test_me_shows_only_the_signed_in_client(app, firm, visitor):
    _, code = firm
    assert visitor.get("/api/client/me").status_code == 401
    sign_in(visitor, app, code["code"])
    me = visitor.get("/api/client/me").json()
    assert me["client"] == {"email": CLIENT_EMAIL} and me["firm"] == {"name": "Firm a (synthetic)"}
    assert me["cases"] == [] and me["can_open_case"] is True and me["financial_years"] == client_auth.financial_year_options()
    assert "firm_id" not in str(me) and "client_identity_id" not in str(me)


def test_logout_revokes_the_session(app, db_path, firm, visitor):
    _, code = firm
    token = sign_in(visitor, app, code["code"]).cookies.get("itr_client_session")
    out = visitor.post("/api/client/logout", headers=H)
    assert out.json() == {"status": "signed_out"} and "max-age=0" in out.headers["set-cookie"].lower()
    visitor.cookies.set("itr_client_session", token)  # replay
    assert visitor.get("/api/client/me").status_code == 401
    assert db_rows(db_path, "SELECT count(*) FROM sessions WHERE kind = 'client' AND revoked_at IS NULL")[0][0] == 0


@pytest.mark.parametrize("column", ["idle_expires_at", "absolute_expires_at"])
def test_expired_client_sessions_are_refused(app, db_path, firm, visitor, column):
    _, code = firm
    sign_in(visitor, app, code["code"])
    conn = connect(db_path)
    conn.execute(f"UPDATE sessions SET {column} = '2000-01-01T00:00:00.000000Z' WHERE kind = 'client'")
    conn.close()
    response = visitor.get("/api/client/me")
    assert response.status_code == 401 and "max-age=0" in response.headers["set-cookie"].lower()
    assert open_case(visitor).status_code == 401


def test_a_suspended_firm_ends_client_sessions(app, db_path, firm, visitor):
    _, code = firm
    sign_in(visitor, app, code["code"])
    conn = connect(db_path)
    auth.admin_suspend_firm(conn, firm_id=repo.find_active_firm_by_code(conn, code["code"])["firm_id"])
    conn.close()
    assert visitor.get("/api/client/me").status_code == 401


def test_client_and_ca_sessions_do_not_cross(app, firm, visitor):
    ca, code = firm
    client_token = sign_in(visitor, app, code["code"]).cookies.get("itr_client_session")
    ca_token = ca.cookies.get("itr_ca_session")
    with new_client(app) as c:
        c.cookies.set("itr_ca_session", client_token)
        assert c.get("/api/ca/me").status_code == 401 and c.get("/api/ca/cases").status_code == 401
    with new_client(app) as c:
        c.cookies.set("itr_client_session", ca_token)
        assert c.get("/api/client/me").status_code == 401
    assert ca.get("/api/client/me").status_code == 401  # a CA cookie alone is not a client session
    assert visitor.get("/api/ca/me").status_code == 401


# === cases ===================================================================================================

def test_opening_a_case_is_idempotent(app, db_path, firm, visitor):
    _, code = firm
    sign_in(visitor, app, code["code"])
    first = open_case(visitor)
    assert first.status_code == 201 and first.json()["created"] is True
    case = first.json()["case"]
    assert case["reference"].startswith("IT-ASHA-") and case["financial_year"] == FY and case["status"] == "draft"
    again = open_case(visitor, first_name="Someone Else")
    assert again.status_code == 200 and again.json() == {"case": case, "created": False}
    assert [core(c) for c in visitor.get("/api/client/me").json()["cases"]] == [case]
    row = db_rows(db_path, "SELECT firm_id, client_identity_id, created_via_firm_code_id FROM cases")
    assert len(row) == 1
    conn = connect(db_path)
    found = repo.find_active_firm_by_code(conn, code["code"])
    identity = repo.get_or_create_client_identity(conn, repo.FirmScope(found["firm_id"]), CLIENT_EMAIL)
    conn.close()
    assert tuple(row[0]) == (found["firm_id"], identity["id"], found["firm_code_id"])


def test_signing_in_again_reuses_the_identity_and_case(app, db_path, firm, visitor):
    _, code = firm
    sign_in(visitor, app, code["code"])
    reference = open_case(visitor).json()["case"]["reference"]
    with new_client(app) as second_browser:
        sign_in(second_browser, app, code["code"])
        assert open_case(second_browser).json() == {"case": core(visitor.get("/api/client/me").json()["cases"][0]),
                                                    "created": False}
        assert second_browser.get("/api/client/me").json()["cases"][0]["reference"] == reference
    assert db_rows(db_path, "SELECT count(*) FROM client_identities")[0][0] == 1


def test_only_a_closed_case_frees_the_slot(app, db_path, firm, visitor):
    _, code = firm
    sign_in(visitor, app, code["code"])
    first = open_case(visitor).json()["case"]
    conn = connect(db_path)
    case_row = conn.execute("SELECT id, firm_id, version FROM cases").fetchone()
    scope = repo.FirmScope(case_row["firm_id"])
    for status in ("submitted", "ca_review_required", "review_ready"):
        current = repo.get_case(conn, scope, case_row["id"])
        repo.update_case(conn, scope, case_row["id"], expected_version=current["version"], status=status)
        assert open_case(visitor).status_code == 200  # still open: same case returned
    current = repo.get_case(conn, scope, case_row["id"])
    repo.update_case(conn, scope, case_row["id"], expected_version=current["version"], status="closed")
    conn.close()
    second = open_case(visitor)
    assert second.status_code == 201 and second.json()["case"]["reference"] != first["reference"]
    assert db_rows(db_path, "SELECT count(*) FROM cases WHERE status <> 'closed'")[0][0] == 1


def test_different_years_get_different_cases(app, firm, visitor):
    _, code = firm
    sign_in(visitor, app, code["code"])
    years = client_auth.financial_year_options()
    refs = {open_case(visitor, financial_year=y).json()["case"]["reference"] for y in years}
    assert len(refs) == len(years)


@pytest.mark.parametrize("year", ["2010-11", "2099-00", "2025-27", "FY2025", "", "2025-26' --"])
def test_only_offered_years_are_accepted(app, firm, visitor, year):
    _, code = firm
    sign_in(visitor, app, code["code"])
    if year in client_auth.financial_year_options():
        pytest.skip("year happens to be offered")
    response = open_case(visitor, financial_year=year)
    assert response.status_code in (400, 422)
    assert not year or year not in response.text.replace("financial_year", "")


@pytest.mark.parametrize("name", ["", "   ", "x" * 101])
def test_a_first_name_is_required(app, firm, visitor, name):
    _, code = firm
    sign_in(visitor, app, code["code"])
    assert open_case(visitor, first_name=name).status_code in (400, 422)


def test_revoking_the_code_stops_new_cases_but_keeps_existing_ones(app, db_path, firm, visitor):
    ca, code = firm
    sign_in(visitor, app, code["code"])
    existing = open_case(visitor).json()["case"]
    ca.post("/api/ca/firm-code/revoke", headers=H)
    me = visitor.get("/api/client/me").json()
    assert me["can_open_case"] is False and [core(c) for c in me["cases"]] == [existing]
    other_year = next(y for y in client_auth.financial_year_options() if y != FY)
    response = open_case(visitor, financial_year=other_year)
    assert response.status_code == 409 and response.json()["error"] == "onboarding_closed"
    assert open_case(visitor).json() == {"case": existing, "created": False}  # the existing case is still returned
    assert [c["reference"] for c in ca.get("/api/ca/cases").json()["cases"]] == [existing["reference"]]


def test_a_concurrent_creation_returns_the_existing_case(app, db_path, firm, visitor, monkeypatch):
    _, code = firm
    sign_in(visitor, app, code["code"])
    conn = connect(db_path)
    principal = client_auth.authenticate_client_session(conn, visitor.cookies.get("itr_client_session"))
    original = repo.find_open_case
    calls = {"n": 0}

    def racing_find(*args, **kwargs):  # the first look misses a case another request is creating
        calls["n"] += 1
        if calls["n"] == 1:
            repo.create_case(conn, principal.scope, client_identity_id=principal.client_identity_id, first_name="Race",
                             financial_year=FY, firm_code_id=principal.firm_code_id)
            raise repo.NotFound()
        return original(*args, **kwargs)

    monkeypatch.setattr(repo, "find_open_case", racing_find)
    case, created = client_auth.open_case(conn, principal, first_name="Asha", financial_year=FY)
    conn.close()
    assert created is False and case["client_first_name"] == "Race"
    assert db_rows(db_path, "SELECT count(*) FROM cases")[0][0] == 1


def test_financial_year_options_follow_the_indian_year():
    assert client_auth.financial_year_options(date(2026, 3, 31)) == ["2025-26", "2024-25", "2023-24"]
    assert client_auth.financial_year_options(date(2026, 4, 1)) == ["2026-27", "2025-26", "2024-25"]
    assert client_auth.financial_year_options(date(2099, 12, 1))[0] == "2099-00"


# === isolation ===========================================================================================

def test_clients_never_see_each_others_cases(app, db_path, firm):
    _, code = firm
    with new_client(app) as one, new_client(app) as two:
        sign_in(one, app, code["code"], "one@example.test")
        sign_in(two, app, code["code"], "two@example.test")
        ref_one = open_case(one, first_name="One").json()["case"]["reference"]
        ref_two = open_case(two, first_name="Two").json()["case"]["reference"]
        for c, mine, theirs in ((one, ref_one, ref_two), (two, ref_two, ref_one)):
            text = c.get("/api/client/me", params={"client_identity_id": "x", "case_id": "y"}).text
            assert mine in text and theirs not in text
        # A browser-supplied identity in the body is rejected outright.
        bad = one.post("/api/client/cases", json={"first_name": "X", "financial_year": FY, "client_identity_id": "z"},
                       headers=H)
        assert bad.status_code == 422


def test_the_same_email_at_two_firms_is_two_separate_clients(app, db_path):
    ca_a, code_a = ca_with_code(app, db_path, "a")
    ca_b, code_b = ca_with_code(app, db_path, "b")
    with new_client(app) as at_a, new_client(app) as at_b:
        sign_in(at_a, app, code_a["code"])
        ref_a = open_case(at_a).json()["case"]["reference"]
        sign_in(at_b, app, code_b["code"])
        ref_b = open_case(at_b).json()["case"]["reference"]
        assert at_b.get("/api/client/me").json()["firm"]["name"] == "Firm b (synthetic)"
        assert [c["reference"] for c in at_b.get("/api/client/me").json()["cases"]] == [ref_b]
    assert [c["reference"] for c in ca_a.get("/api/ca/cases").json()["cases"]] == [ref_a]
    assert [c["reference"] for c in ca_b.get("/api/ca/cases").json()["cases"]] == [ref_b]
    assert db_rows(db_path, "SELECT count(*) FROM client_identities")[0][0] == 2
    ca_a.close(), ca_b.close()


def test_the_ca_dashboard_data_shows_the_new_case(app, firm, visitor):
    ca, code = firm
    assert ca.get("/api/ca/cases").json() == {"cases": []}
    sign_in(visitor, app, code["code"])
    case = open_case(visitor).json()["case"]
    listed = ca.get("/api/ca/cases").json()["cases"]
    assert listed == [{"reference": case["reference"], "financial_year": FY, "status": "draft",
                       "updated_at": case["updated_at"], "created_at": case["created_at"],
                       "client_first_name": "Asha", "client_email": CLIENT_EMAIL,
                       "profile": {"full_name": None, "bank_name": None, "account_last4": None, "complete": False},
                       "readiness": {"statement": "none", "unverified_reasons": [], "documents": {
                           "required_outstanding": 0, "required_received": 0, "required_waived": 0,
                           "optional_outstanding": 0, "total_requests": 0}}}]


def test_the_database_refuses_a_firm_code_from_another_firm(app, db_path):
    ca_a, code_a = ca_with_code(app, db_path, "a")
    ca_b, code_b = ca_with_code(app, db_path, "b")
    ca_a.close(), ca_b.close()
    conn = connect(db_path)
    firm_a = repo.find_active_firm_by_code(conn, code_a["code"])
    firm_b = repo.find_active_firm_by_code(conn, code_b["code"])
    with pytest.raises(repo.InvalidInput):
        repo.create_challenge(conn, purpose="client_login", subject=CLIENT_EMAIL, secret_hash="a" * 64, max_attempts=5,
                              expires_at="2099-01-01T00:00:00.000000Z", firm_id=firm_a["firm_id"],
                              firm_code_id=firm_b["firm_code_id"])
    identity = repo.get_or_create_client_identity(conn, repo.FirmScope(firm_a["firm_id"]), CLIENT_EMAIL)
    with pytest.raises(repo.InvalidInput):
        repo.create_session(conn, kind="client", firm_id=firm_a["firm_id"], token_hash="b" * 64,
                            idle_expires_at="2099-01-01T00:00:00.000000Z", absolute_expires_at="2099-01-01T00:00:00.000000Z",
                            client_identity_id=identity["id"], firm_code_id=firm_b["firm_code_id"])
    conn.close()


# === CSRF, safe errors and logs ===========================================================================

@pytest.mark.parametrize("headers", [{}, {"X-ITR-Request": "1"}, {"Origin": DEV_ORIGIN},
                                     {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}])
def test_client_changes_need_origin_and_csrf_header(app, db_path, firm, visitor, headers):
    _, code = firm
    for path, body in (("/api/client/start", {"firm_code": code["code"], "email": CLIENT_EMAIL}),
                       ("/api/client/verify", {"token": "t"}),
                       ("/api/client/cases", {"first_name": "A", "financial_year": FY}),
                       ("/api/client/logout", None)):
        response = visitor.post(path, json=body, headers=headers)
        assert response.status_code == 403 and response.json() == {"error": "forbidden", "message": "Request not allowed."}
    assert client_sign_in_rows(db_path) == []


def test_validation_errors_do_not_echo_input(visitor):
    response = visitor.post("/api/client/start", json={"firm_code": "SECRETCODE1234", "email": 12345, "x": "secret-xyz"},
                            headers=H)
    assert response.status_code == 422 and "secret-xyz" not in response.text and "SECRETCODE1234" not in response.text


def test_database_errors_are_generic(app, firm, monkeypatch):
    _, code = firm

    def boom(*args, **kwargs):
        raise sqlite3.OperationalError("no such table: firm_codes WHERE code = 'X'")

    monkeypatch.setattr(repo, "find_active_firm_by_code", boom)
    with new_client(app, raise_server_exceptions=False) as c:
        response = c.post("/api/client/start", json={"firm_code": code["code"], "email": CLIENT_EMAIL}, headers=H)
    assert response.status_code == 500
    assert response.json() == {"error": "internal_error", "message": "Something went wrong."}
    assert "firm_codes" not in response.text


def test_logs_hold_no_emails_codes_or_tokens(app, firm, visitor, caplog):
    _, code = firm
    with caplog.at_level(logging.DEBUG):
        start(visitor, code["code"])
        token = sign_in_link(app)
        cookie = verify(visitor, token).cookies.get("itr_client_session")
        open_case(visitor)
    for secret in (CLIENT_EMAIL, code["code"], code["display"], token.split(".")[1], cookie):
        assert secret not in caplog.text


def test_there_are_no_client_download_routes(app):
    routes = {(r.path, m) for r in app.routes if r.path.startswith("/api/client") for m in getattr(r, "methods", ())}
    assert routes == {("/api/client/start", "POST"), ("/api/client/verify", "POST"), ("/api/client/me", "GET"),
                      ("/api/client/cases", "POST"), ("/api/client/logout", "POST"),
                      ("/api/client/cases/{reference}/profile", "POST"),
                      ("/api/client/cases/{reference}/statements", "POST"),
                      ("/api/client/cases/{reference}/document-requests/{request_id}/files", "POST")}  # uploads only


def test_client_challenge_ttl_is_short():
    assert client_auth.CLIENT_CHALLENGE_TTL <= timedelta(minutes=30)
