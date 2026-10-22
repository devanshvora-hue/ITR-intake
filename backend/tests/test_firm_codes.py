"""Firm codes (Stage 5.5): creation, uniqueness, rotation, revocation,
permissions, firm isolation, CSRF, abuse limits and safe errors. In-process
client, temporary databases and synthetic accounts only."""

import logging
import re
import sqlite3

import pytest

import itr_intake_server.app as app_module
import itr_intake_server.ca_auth as auth
import itr_intake_server.firm_codes as firm_codes
import itr_intake_server.repository as repo
from itr_intake_server.app import create_app
from itr_intake_server.db import connect
from itr_intake_server.ids import FIRM_CODE_LENGTH, format_firm_code, new_firm_code
from itr_intake_server.settings import Settings
from test_server_app import DEV_ORIGIN, H, PASSWORD, db_rows, login, new_client, onboard, register, verify

BASE = "/api/ca/firm-code"
ALPHABET = set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")


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


@pytest.fixture
def signed_in(client, app, db_path):
    onboard(client, app, db_path)
    assert login(client).status_code == 200
    return client


def create(client, headers=H):
    return client.post(BASE, headers=headers)


def rotate(client, headers=H):
    return client.post(f"{BASE}/rotate", headers=headers)


def revoke(client, headers=H):
    return client.post(f"{BASE}/revoke", headers=headers)


def state(client):
    response = client.get(BASE)
    assert response.status_code == 200
    return response.json()


def lookup(db_path, code):
    conn = connect(db_path)
    try:
        return repo.find_active_firm_by_code(conn, code)
    finally:
        conn.close()


def firm_id(db_path, tag="a"):
    conn = connect(db_path)
    try:
        return repo.get_ca_user_for_login(conn, f"ca-{tag}@example.test")["firm_id"]
    finally:
        conn.close()


# === generator =========================================================================================

def test_generated_codes_are_random_readable_and_well_formed():
    codes = {new_firm_code() for _ in range(500)}
    assert len(codes) == 500
    assert all(len(c) == FIRM_CODE_LENGTH and set(c) <= ALPHABET for c in codes)  # no I, L, O or U
    assert format_firm_code("7K4P92XMQR3T") == "7K4P-92XM-QR3T"


# === viewing and creating ==================================================================================

def test_a_new_firm_has_no_code(signed_in):
    assert state(signed_in) == {"active": None, "previous": [], "can_manage": True}


def test_create_returns_a_readable_code_and_is_idempotent(signed_in, db_path):
    first = create(signed_in)
    assert first.status_code == 201 and first.json()["created"] is True
    code = first.json()["firm_code"]
    assert code["status"] == "active" and len(code["code"]) == FIRM_CODE_LENGTH
    assert code["display"] == format_firm_code(code["code"]) and re.fullmatch(r"[0-9A-Z]{4}(-[0-9A-Z]{4}){2}", code["display"])
    again = create(signed_in)
    assert again.status_code == 200 and again.json() == {"firm_code": code, "created": False}
    assert state(signed_in)["active"] == code
    assert db_rows(db_path, "SELECT count(*) FROM firm_codes")[0][0] == 1
    assert lookup(db_path, code["display"])["firm_name"] == "Firm a (synthetic)"  # dashes are accepted


def test_responses_never_include_internal_ids(signed_in, db_path):
    create(signed_in)
    text = signed_in.get(BASE).text + create(signed_in).text
    assert firm_id(db_path) not in text
    code_id = db_rows(db_path, "SELECT id FROM firm_codes")[0][0]
    assert code_id not in text


# === uniqueness =========================================================================================

def test_a_collision_with_another_firms_code_is_retried(app, db_path, monkeypatch):
    sequence = iter(["AAAA1111BBBB", "AAAA1111BBBB", "CCCC2222DDDD"])
    monkeypatch.setattr(firm_codes, "new_firm_code", lambda: next(sequence))
    with new_client(app) as a, new_client(app) as b:
        onboard(a, app, db_path, "a"), onboard(b, app, db_path, "b")
        login(a, "a"), login(b, "b")
        assert create(a).json()["firm_code"]["code"] == "AAAA1111BBBB"
        assert create(b).json()["firm_code"]["code"] == "CCCC2222DDDD"
        assert state(a)["active"]["code"] == "AAAA1111BBBB"


def test_repeated_collisions_fail_safely(app, db_path, monkeypatch):
    with new_client(app) as a, new_client(app) as b:
        onboard(a, app, db_path, "a"), onboard(b, app, db_path, "b")
        login(a, "a"), login(b, "b")
        monkeypatch.setattr(firm_codes, "new_firm_code", lambda: "EEEE3333FFFF")
        create(a)
        for response in (create(b), rotate(b)):
            assert response.status_code == 503
            assert response.json() == {"error": "unavailable", "message": "A firm code could not be created. Please try again."}
            assert "EEEE" not in response.text
        assert state(b)["active"] is None


# === rotation ===========================================================================================

def test_rotation_replaces_the_code_and_the_old_one_stops_working(signed_in, db_path):
    old = create(signed_in).json()["firm_code"]
    response = rotate(signed_in)
    assert response.status_code == 200
    new = response.json()["firm_code"]
    assert new["status"] == "active" and new["code"] != old["code"]
    current = state(signed_in)
    assert current["active"] == new
    assert [p["code"] for p in current["previous"]] == [old["code"]]
    assert current["previous"][0]["status"] == "revoked" and current["previous"][0]["revoked_at"]
    with pytest.raises(repo.NotFound):  # no grace period: the old code is refused at once
        lookup(db_path, old["code"])
    assert lookup(db_path, new["code"])["firm_name"] == "Firm a (synthetic)"
    assert db_rows(db_path, "SELECT count(*) FROM firm_codes WHERE status = 'active'")[0][0] == 1


def test_rotation_without_an_active_code_creates_one(signed_in):
    response = rotate(signed_in)
    assert response.status_code == 200 and state(signed_in)["active"] == response.json()["firm_code"]


def test_history_is_limited_and_newest_first(signed_in):
    create(signed_in)
    codes = [rotate(signed_in).json()["firm_code"]["code"] for _ in range(7)]
    current = state(signed_in)
    assert current["active"]["code"] == codes[-1]
    assert [p["code"] for p in current["previous"]] == list(reversed(codes[1:-1]))[:5]
    assert all(p["status"] == "revoked" for p in current["previous"])


# === revocation =========================================================================================

def test_revocation_stops_onboarding_but_keeps_existing_cases(signed_in, db_path):
    code = create(signed_in).json()["firm_code"]
    conn = connect(db_path)
    found = repo.find_active_firm_by_code(conn, code["code"])
    scope = repo.FirmScope(found["firm_id"])
    identity = repo.get_or_create_client_identity(conn, scope, "client-x@example.test")
    case = repo.create_case(conn, scope, client_identity_id=identity["id"], first_name="Demo",
                            financial_year="2025-26", firm_code_id=found["firm_code_id"])
    conn.close()

    response = revoke(signed_in)
    assert response.status_code == 200 and response.json()["revoked"]["status"] == "revoked"
    assert state(signed_in)["active"] is None
    with pytest.raises(repo.NotFound):
        lookup(db_path, code["code"])
    cases = signed_in.get("/api/ca/cases").json()["cases"]
    assert [c["reference"] for c in cases] == [case["reference"]]  # the existing case is untouched
    assert db_rows(db_path, "SELECT created_via_firm_code_id FROM cases")[0][0] == found["firm_code_id"]


def test_revoking_without_an_active_code_is_a_clear_conflict(signed_in):
    assert revoke(signed_in).json() == {"error": "no_active_code", "message": "Your firm has no active code."}
    assert revoke(signed_in).status_code == 409
    create(signed_in), revoke(signed_in)
    assert revoke(signed_in).status_code == 409


def test_a_revoked_code_is_never_reissued_as_active(signed_in, db_path):
    old = create(signed_in).json()["firm_code"]["code"]
    revoke(signed_in)
    new = create(signed_in).json()["firm_code"]["code"]
    assert new != old
    assert db_rows(db_path, "SELECT status FROM firm_codes WHERE code = ?", (old,))[0][0] == "revoked"


# === who may use the routes ==============================================================================

@pytest.mark.parametrize("method, path", [("get", BASE), ("post", BASE), ("post", f"{BASE}/rotate"),
                                          ("post", f"{BASE}/revoke")])
def test_unauthenticated_requests_are_refused(client, method, path):
    response = getattr(client, method)(path, headers=H)
    assert response.status_code == 401 and response.json()["error"] == "unauthenticated"


@pytest.mark.parametrize("headers", [{}, {"X-ITR-Request": "1"}, {"Origin": DEV_ORIGIN},
                                     {"Origin": "https://evil.example.test", "X-ITR-Request": "1"}])
def test_changes_need_origin_and_csrf_header(signed_in, db_path, headers):
    for call in (create, rotate, revoke):
        response = call(signed_in, headers=headers)
        assert response.status_code == 403 and response.json() == {"error": "forbidden", "message": "Request not allowed."}
    assert db_rows(db_path, "SELECT count(*) FROM firm_codes")[0][0] == 0


def test_pending_accounts_cannot_sign_in_to_manage_codes(client, app, db_path):
    register(client)
    assert login(client).status_code == 401  # unverified
    verify(client, app)
    assert login(client).status_code == 401  # verified, not approved
    assert create(client).status_code == 401
    assert db_rows(db_path, "SELECT count(*) FROM firm_codes")[0][0] == 0


def test_suspending_the_firm_ends_code_management_at_once(signed_in, db_path):
    create(signed_in)
    conn = connect(db_path)
    auth.admin_suspend_firm(conn, firm_id=firm_id(db_path))
    conn.close()
    for response in (signed_in.get(BASE), create(signed_in), rotate(signed_in), revoke(signed_in)):
        assert response.status_code == 401
    assert db_rows(db_path, "SELECT count(*) FROM firm_codes WHERE status = 'active'")[0][0] == 1  # untouched
    with pytest.raises(repo.NotFound):  # and a suspended firm's code is not accepted for onboarding
        lookup(db_path, db_rows(db_path, "SELECT code FROM firm_codes")[0][0])


def test_a_deactivated_user_loses_access_at_once(signed_in, db_path):
    conn = connect(db_path)
    user = repo.get_ca_user_for_login(conn, "ca-a@example.test")
    auth.admin_deactivate_ca_user(conn, firm_id=user["firm_id"], user_id=user["id"])
    conn.close()
    assert create(signed_in).status_code == 401 and signed_in.get(BASE).status_code == 401


def test_a_member_can_view_but_not_change_the_code(signed_in, app, db_path):
    code = create(signed_in).json()["firm_code"]
    conn = connect(db_path)
    scope = repo.FirmScope(firm_id(db_path))
    member = repo.create_ca_user(conn, firm_id=scope.firm_id, email="member-a@example.test",
                                 full_name="Member (synthetic)", password_hash=auth.hash_password(PASSWORD), role="member")
    repo.mark_ca_user_email_verified(conn, scope, member["id"])
    repo.set_ca_user_status(conn, scope, member["id"], "active")
    conn.close()
    with new_client(app) as m:
        assert m.post("/api/ca/login", json={"email": "member-a@example.test", "password": PASSWORD}, headers=H).status_code == 200
        assert state(m) == {"active": code, "previous": [], "can_manage": False}
        for call in (create, rotate, revoke):
            response = call(m)
            assert response.status_code == 403 and response.json()["error"] == "not_permitted"
    assert state(signed_in)["active"] == code


# === firm isolation ========================================================================================

def test_each_firm_sees_and_changes_only_its_own_code(app, db_path):
    with new_client(app) as a, new_client(app) as b:
        onboard(a, app, db_path, "a"), onboard(b, app, db_path, "b")
        login(a, "a"), login(b, "b")
        code_a, code_b = create(a).json()["firm_code"], create(b).json()["firm_code"]
        b_firm = firm_id(db_path, "b")
        # Browser-supplied firm IDs are ignored everywhere.
        assert a.get(BASE, params={"firm_id": b_firm}).json()["active"] == code_a
        assert a.post(f"{BASE}/revoke", params={"firm_id": b_firm}, json={"firm_id": b_firm}, headers=H).status_code == 200
        assert state(b)["active"] == code_b
        assert a.post(f"{BASE}/rotate", json={"firm_id": b_firm}, headers=H).status_code == 200
        assert state(b)["active"] == code_b and lookup(db_path, code_b["code"])["firm_name"] == "Firm b (synthetic)"
        assert code_b["code"] not in a.get(BASE).text


# === abuse limits ======================================================================================

def test_changes_are_limited_per_firm(signed_in, monkeypatch):
    monkeypatch.setattr(app_module, "FIRM_CODE_CHANGES_PER_FIRM", 3)
    statuses = [rotate(signed_in).status_code for _ in range(5)]
    assert statuses == [200, 200, 200, 429, 429]
    assert rotate(signed_in).json() == {"error": "rate_limited",
                                        "message": "Too many firm code changes. Please try again later."}
    assert signed_in.get(BASE).status_code == 200  # viewing is never limited


def test_forged_forwarding_headers_do_not_reset_the_peer_limit(signed_in, monkeypatch):
    monkeypatch.setattr(app_module, "FIRM_CODE_CHANGES_PER_PEER", 2)
    statuses = [rotate(signed_in, headers={**H, "X-Forwarded-For": f"203.0.113.{i}", "X-Real-IP": f"198.51.100.{i}"}).status_code
                for i in range(3)]
    assert statuses == [200, 200, 429]


def test_limit_counters_hold_hashes_only(signed_in, db_path):
    rotate(signed_in)
    buckets = [r[0] for r in db_rows(db_path, "SELECT bucket FROM rate_limits WHERE bucket LIKE 'firm-code-%'")]
    assert len(buckets) == 2 and firm_id(db_path) not in "".join(buckets) and "127.0.0.1" not in "".join(buckets)


# === safe errors, logs and audit ===========================================================================

def test_database_errors_are_generic(signed_in, app, monkeypatch):
    def boom(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked: UPDATE firm_codes SET status = 'revoked'")

    monkeypatch.setattr(repo, "rotate_firm_code", boom)
    with new_client(app, raise_server_exceptions=False) as c:
        c.cookies.update(signed_in.cookies)
        response = c.post(f"{BASE}/rotate", headers=H)
    assert response.status_code == 500
    assert response.json() == {"error": "internal_error", "message": "Something went wrong."}
    assert "firm_codes" not in response.text and "UPDATE" not in response.text


def test_codes_stay_out_of_logs_and_audit_details(signed_in, db_path, caplog):
    with caplog.at_level(logging.DEBUG):
        first = create(signed_in).json()["firm_code"]["code"]
        second = rotate(signed_in).json()["firm_code"]["code"]
        revoke(signed_in)
    assert first not in caplog.text and second not in caplog.text
    events = db_rows(db_path, "SELECT action, details_json, actor_kind FROM audit_events WHERE action LIKE 'firm_code.%' "
                              "ORDER BY created_at")
    assert [e[0] for e in events] == ["firm_code.created", "firm_code.rotated", "firm_code.revoked"]
    assert all(e[2] == "ca" and first not in e[1] and second not in e[1] for e in events)


def test_firm_code_routes_do_not_exist_outside_the_api_prefix(app):
    paths = {r.path for r in app.routes}
    assert {BASE, f"{BASE}/rotate", f"{BASE}/revoke"} <= paths
    assert not any("firm_id" in p or "{" in p for p in paths if "firm-code" in p)  # no IDs in paths
