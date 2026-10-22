"""Stage 5.3: CA authentication and server-side sessions.
Temporary databases and synthetic records only; no network."""

import hashlib
import inspect
from datetime import UTC, datetime, timedelta

import pytest

import itr_intake_server.ca_auth as auth
import itr_intake_server.repository as repo
from itr_intake_server.db import initialize_database
from itr_intake_server.ids import generate_id

PASSWORD = "synthetic-pass-9481"
T0 = datetime(2025, 7, 1, 9, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def fast_scrypt(monkeypatch, request):
    """Cheaper scrypt for speed; hashes carry their own parameters, so this
    changes nothing else. `test_default_scrypt_parameters` opts out."""
    if request.node.name != "test_default_scrypt_parameters":
        monkeypatch.setattr(auth, "SCRYPT_N", 2**10)


@pytest.fixture
def db(tmp_path):
    conn = initialize_database(tmp_path / "auth.db")
    yield conn
    conn.close()


def register(db, tag="a", email=None, registration_number=None):
    return auth.register_ca(db, full_name=f"CA {tag} (synthetic)", email=email or f"ca-{tag}@example.test",
                            password=PASSWORD, firm_name=f"Firm {tag} (synthetic)",
                            registration_number=registration_number)


def approved(db, tag="a"):
    reg = register(db, tag)
    auth.confirm_email(db, auth.start_email_verification(db, reg.user_id, now=T0), now=T0)
    auth.admin_approve_ca(db, firm_id=reg.firm_id, user_id=reg.user_id, approved_by="operator")
    return reg


def login(db, tag="a", **kw):
    return auth.login_ca(db, f"ca-{tag}@example.test", PASSWORD, now=kw.pop("now", T0), **kw)


def failure_message(callable_):
    with pytest.raises(auth.AuthenticationFailed) as info:
        callable_()
    return type(info.value), str(info.value)


# === passwords ===================================================================================

def test_hash_and_verify():
    stored = auth.hash_password(PASSWORD)
    assert stored.startswith("scrypt$1024$8$1$") and PASSWORD not in stored
    assert auth.verify_password(PASSWORD, stored)
    assert not auth.verify_password(PASSWORD + "x", stored)
    assert not auth.verify_password("", stored)
    assert auth.hash_password(PASSWORD) != stored  # random salt


def test_default_scrypt_parameters():
    stored = auth.hash_password(PASSWORD)
    assert stored.startswith("scrypt$32768$8$1$")
    assert auth.verify_password(PASSWORD, stored)


@pytest.mark.parametrize(
    "stored",
    ["", "plain-text-password", "scrypt$abc", "bcrypt$1024$8$1$c2FsdA$aGFzaA", "scrypt$1000$8$1$c2FsdA$aGFzaA",
     "scrypt$1073741824$8$1$c2FsdA$aGFzaA", "scrypt$1024$0$1$c2FsdA$aGFzaA", "scrypt$1024$8$1$$aGFzaA",
     "scrypt$1024$8$1$c2FsdA$", "scrypt$1024$8$1$!!$aGFzaA", None, b"scrypt$1024$8$1$c2FsdA$aGFzaA", 12345],
)
def test_malformed_stored_hashes_never_verify(stored):
    assert auth.verify_password(PASSWORD, stored) is False


def test_verification_is_constant_time(monkeypatch):
    calls = []
    real = auth.hmac.compare_digest
    monkeypatch.setattr(auth.hmac, "compare_digest", lambda a, b: calls.append(1) or real(a, b))
    stored = auth.hash_password(PASSWORD)
    auth.verify_password("wrong-password-123", stored)
    auth.verify_password(PASSWORD, stored)
    assert len(calls) == 2


@pytest.mark.parametrize("password, code", [
    ("short", "password_too_short"), ("x" * 300, "password_too_long"), ("aaaaaaaaaaaaaa", "password_too_common"),
    ("password1234", "password_too_common"), (None, "password_invalid"),
])
def test_password_policy(db, password, code):
    with pytest.raises(auth.RegistrationError, match=code):
        auth.register_ca(db, full_name="X", email="x@example.test", password=password, firm_name="X (synthetic)")


# === registration ===================================================================================

def test_registration_is_pending_and_issues_nothing(db):
    reg = register(db, email="  CA-A@Example.TEST ")
    assert reg.email == "ca-a@example.test"
    scope = repo.FirmScope(reg.firm_id)
    assert repo.get_firm(db, scope)["status"] == "pending_verification"
    user = repo.get_ca_user(db, scope, reg.user_id)
    assert (user["status"], user["role"], user["email_verified_at"]) == ("pending", "owner", None)
    assert user["password_hash"].startswith("scrypt$") and PASSWORD not in user["password_hash"]
    assert db.execute("SELECT count(*) FROM firm_codes").fetchone()[0] == 0
    assert db.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0


def test_duplicate_registration_is_refused_atomically(db):
    register(db, "a", registration_number="FRN-A-SYN")
    with pytest.raises(auth.RegistrationError, match="email_taken"):
        register(db, "b", email="CA-A@EXAMPLE.test")
    with pytest.raises(auth.RegistrationError, match="registration_number_taken"):
        register(db, "c", registration_number="FRN-A-SYN")
    # The firm rows of the failed attempts were rolled back with them.
    assert db.execute("SELECT count(*) FROM firms").fetchone()[0] == 1
    assert db.execute("SELECT count(*) FROM ca_users").fetchone()[0] == 1


def test_invalid_registration_email(db):
    with pytest.raises(auth.RegistrationError, match="email_invalid"):
        register(db, email="not-an-email")


# === lifecycle: verification is not approval ==============================================================

def test_pending_account_cannot_log_in(db):
    register(db)
    with pytest.raises(auth.AuthenticationFailed):
        login(db)


def test_email_verification_does_not_approve(db):
    reg = register(db)
    auth.confirm_email(db, auth.start_email_verification(db, reg.user_id, now=T0), now=T0)
    scope = repo.FirmScope(reg.firm_id)
    assert repo.get_firm(db, scope)["status"] == "pending_approval"
    assert repo.get_ca_user(db, scope, reg.user_id)["status"] == "pending"
    with pytest.raises(auth.AuthenticationFailed):
        login(db)
    auth.admin_approve_ca(db, firm_id=reg.firm_id, user_id=reg.user_id, approved_by="operator")
    assert login(db).principal.user_id == reg.user_id
    assert db.execute("SELECT count(*) FROM firm_codes").fetchone()[0] == 0  # approval issues no code


def test_approval_requires_a_verified_email(db):
    reg = register(db)
    with pytest.raises(auth.ApprovalError, match="email_not_verified"):
        auth.admin_approve_ca(db, firm_id=reg.firm_id, user_id=reg.user_id, approved_by="operator")
    with pytest.raises(auth.ApprovalError, match="approver_required"):
        auth.admin_approve_ca(db, firm_id=reg.firm_id, user_id=reg.user_id, approved_by=" ")
    other = register(db, "b")
    with pytest.raises(auth.ApprovalError, match="not_found"):  # user of another firm
        auth.admin_approve_ca(db, firm_id=reg.firm_id, user_id=other.user_id, approved_by="operator")


def test_verification_tokens(db):
    reg = register(db)
    token = auth.start_email_verification(db, reg.user_id, now=T0)
    challenge_id, secret = token.split(".")
    stored = db.execute("SELECT secret_hash FROM verification_challenges").fetchone()[0]
    assert secret not in stored and stored == hashlib.sha256(secret.encode()).hexdigest()
    bad_secret = secret[:-1] + ("A" if secret[-1] != "A" else "B")
    for bad in (None, "", "no-dot", f"{challenge_id}.short", f"{challenge_id}.{bad_secret}", f"{generate_id()}.{secret}",
                f"{challenge_id}.{secret}.extra"):
        with pytest.raises(auth.VerificationFailed):
            auth.confirm_email(db, bad, now=T0)
    assert repo.get_challenge(db, challenge_id)["attempts"] == 1  # the wrong secret counted
    with pytest.raises(auth.VerificationFailed):
        auth.confirm_email(db, token, now=T0 + timedelta(hours=25))  # expired
    auth.confirm_email(db, token, now=T0)
    with pytest.raises(auth.VerificationFailed):
        auth.confirm_email(db, token, now=T0)  # single use


def test_verification_attempts_run_out(db):
    reg = register(db)
    token = auth.start_email_verification(db, reg.user_id, now=T0)
    challenge_id, secret = token.split(".")
    wrong = f"{challenge_id}.{'A' * 43}"
    for _ in range(auth.EMAIL_VERIFICATION_ATTEMPTS):
        with pytest.raises(auth.VerificationFailed):
            auth.confirm_email(db, wrong, now=T0)
    with pytest.raises(auth.VerificationFailed):
        auth.confirm_email(db, token, now=T0)  # even the right secret, once attempts are used up


# === inactive firms and accounts ===============================================================================

def test_deactivated_user_cannot_authenticate_and_loses_sessions(db):
    reg = approved(db)
    first, second = login(db), login(db)
    assert auth.admin_deactivate_ca_user(db, firm_id=reg.firm_id, user_id=reg.user_id) == 2
    for token in (first.token, second.token):
        with pytest.raises(auth.SessionInvalid):
            auth.authenticate_ca_session(db, token, now=T0)
    with pytest.raises(auth.AuthenticationFailed):
        login(db)
    with pytest.raises(auth.ApprovalError, match="account_disabled"):
        auth.admin_approve_ca(db, firm_id=reg.firm_id, user_id=reg.user_id, approved_by="operator")


def test_suspended_firm_cannot_authenticate(db):
    reg = approved(db)
    session = login(db)
    assert auth.admin_suspend_firm(db, firm_id=reg.firm_id) == 1
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, session.token, now=T0)
    with pytest.raises(auth.AuthenticationFailed):
        login(db)


def test_status_change_outside_the_service_still_blocks_existing_sessions(db):
    reg = approved(db)
    session = login(db)
    repo.set_ca_user_status(db, repo.FirmScope(reg.firm_id), reg.user_id, "disabled")  # no revocation done
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, session.token, now=T0)
    assert db.execute("SELECT revoked_at FROM sessions").fetchone()[0] is not None


def test_lockout_after_repeated_failures(db):
    approved(db)
    for _ in range(auth.MAX_FAILED_LOGINS):
        with pytest.raises(auth.AuthenticationFailed):
            auth.login_ca(db, "ca-a@example.test", "wrong-password-123", now=T0)
    with pytest.raises(auth.AuthenticationFailed):
        login(db, now=T0 + timedelta(minutes=5))  # right password, but locked
    result = login(db, now=T0 + auth.LOCKOUT + timedelta(seconds=1))
    assert db.execute("SELECT failed_logins, locked_until FROM ca_users").fetchone()[:] == (0, None)
    assert result.principal


# === generic failures =========================================================================================

def test_login_failures_are_indistinguishable(db):
    approved(db, "a")
    register(db, "pending")
    unverified = register(db, "unverified")
    auth.confirm_email(db, auth.start_email_verification(db, unverified.user_id, now=T0), now=T0)
    disabled = approved(db, "disabled")
    auth.admin_deactivate_ca_user(db, firm_id=disabled.firm_id, user_id=disabled.user_id)
    suspended = approved(db, "suspended")
    auth.admin_suspend_firm(db, firm_id=suspended.firm_id)
    locked = approved(db, "locked")
    for _ in range(auth.MAX_FAILED_LOGINS):
        with pytest.raises(auth.AuthenticationFailed):
            auth.login_ca(db, "ca-locked@example.test", "wrong-password-123", now=T0)

    outcomes = {
        "unknown email": failure_message(lambda: auth.login_ca(db, "nobody@example.test", PASSWORD, now=T0)),
        "malformed email": failure_message(lambda: auth.login_ca(db, "not an email", PASSWORD, now=T0)),
        "wrong password": failure_message(lambda: auth.login_ca(db, "ca-a@example.test", "wrong-password-1", now=T0)),
        "pending": failure_message(lambda: login(db, "pending")),
        "verified, not approved": failure_message(lambda: login(db, "unverified")),
        "disabled": failure_message(lambda: login(db, "disabled")),
        "suspended firm": failure_message(lambda: login(db, "suspended")),
        "locked": failure_message(lambda: login(db, "locked")),
        "non-string password": failure_message(lambda: auth.login_ca(db, "ca-a@example.test", None, now=T0)),
    }
    assert len(set(outcomes.values())) == 1, outcomes
    assert outcomes["unknown email"] == (auth.AuthenticationFailed, "Invalid email or password.")


def test_unknown_email_still_does_password_work(db, monkeypatch):
    calls = []
    real = auth.hashlib.scrypt
    monkeypatch.setattr(auth.hashlib, "scrypt", lambda *a, **k: calls.append(1) or real(*a, **k))
    with pytest.raises(auth.AuthenticationFailed):
        auth.login_ca(db, "nobody@example.test", PASSWORD, now=T0)
    assert calls == [1]  # exactly one real scrypt run


# === sessions ================================================================================================

def test_raw_tokens_and_passwords_are_never_stored(db):
    reg = approved(db)
    results = [login(db) for _ in range(3)]
    rotated = auth.rotate_ca_session(db, results[0].token, now=T0)
    verification = auth.start_email_verification(db, reg.user_id, now=T0)
    secrets_to_find = [r.token for r in results] + [rotated.token, verification.split(".")[1], PASSWORD]
    for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall():
        for row in db.execute(f"SELECT * FROM {table}"):
            for value in row:
                if isinstance(value, str):
                    assert not any(s in value for s in secrets_to_find), table
    hashes = {r[0] for r in db.execute("SELECT token_hash FROM sessions")}
    assert hashlib.sha256(results[1].token.encode()).hexdigest() in hashes


def test_login_creates_a_new_session_and_logout_revokes_it(db):
    reg = approved(db)
    first = login(db)
    second = login(db)
    assert first.token != second.token and len(first.token) == 43
    assert db.execute("SELECT count(*) FROM sessions WHERE revoked_at IS NULL").fetchone()[0] == 2
    principal = auth.authenticate_ca_session(db, first.token, now=T0)
    assert (principal.user_id, principal.firm_id, principal.scope) == (reg.user_id, reg.firm_id, repo.FirmScope(reg.firm_id))
    auth.logout_ca(db, first.token)
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, first.token, now=T0)
    assert auth.authenticate_ca_session(db, second.token, now=T0)  # other sessions unaffected
    auth.logout_ca(db, first.token)  # idempotent
    auth.logout_ca(db, "unknown-token")  # silent
    auth.logout_ca(db, None)


def test_login_rotates_a_presented_session(db):
    approved(db)
    old = login(db)
    new = login(db, previous_token=old.token)
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, old.token, now=T0)
    assert auth.authenticate_ca_session(db, new.token, now=T0)


def test_explicit_rotation_keeps_absolute_expiry(db):
    approved(db)
    old = login(db)
    new = auth.rotate_ca_session(db, old.token, now=T0 + timedelta(minutes=10))
    assert new.token != old.token
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, old.token, now=T0 + timedelta(minutes=10))
    assert new.principal.absolute_expires_at == old.principal.absolute_expires_at


def test_idle_expiry(db):
    approved(db)
    session = login(db)
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, session.token, now=T0 + timedelta(minutes=30))
    assert db.execute("SELECT revoked_at FROM sessions").fetchone()[0] is not None
    with pytest.raises(auth.SessionInvalid):  # stays dead
        auth.authenticate_ca_session(db, session.token, now=T0 + timedelta(minutes=1))


def test_activity_slides_idle_expiry_but_not_past_absolute(db):
    approved(db)
    session = login(db)
    moment = T0
    while moment + timedelta(minutes=25) < T0 + auth.CA_SESSION_ABSOLUTE:
        moment += timedelta(minutes=25)
        principal = auth.authenticate_ca_session(db, session.token, now=moment)
        assert principal.idle_expires_at <= principal.absolute_expires_at
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, session.token, now=T0 + auth.CA_SESSION_ABSOLUTE)


def test_absolute_expiry_boundary(db):
    approved(db)
    session = login(db)
    for minutes in range(20, 12 * 60, 20):
        auth.authenticate_ca_session(db, session.token, now=T0 + timedelta(minutes=minutes))
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, session.token, now=T0 + timedelta(hours=12))


@pytest.mark.parametrize("token", [None, "", "short", "x" * 44, "a" * 42 + " ", "é" * 43, 12345,
                                   "' OR 1=1 --".ljust(43, "x")])
def test_missing_and_malformed_tokens(db, token):
    approved(db)
    login(db)
    with pytest.raises(auth.SessionInvalid) as info:
        auth.authenticate_ca_session(db, token, now=T0)
    assert str(info.value) == "Session is invalid or has expired."


def test_tampered_and_revoked_tokens(db):
    approved(db)
    session = login(db)
    t = session.token
    for tampered in (t[:-1] + ("A" if t[-1] != "A" else "B"), t[1:] + t[0], t.swapcase()):
        with pytest.raises(auth.SessionInvalid):
            auth.authenticate_ca_session(db, tampered, now=T0)
    auth.logout_ca(db, t)
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, t, now=T0)


def test_no_session_operation_accepts_a_session_id(db):
    approved(db)
    session = login(db)
    session_id = db.execute("SELECT id FROM sessions").fetchone()[0]
    for name, fn in inspect.getmembers(auth, inspect.isfunction):
        if fn.__module__ == auth.__name__ and not name.startswith("_"):
            assert "session_id" not in inspect.signature(fn).parameters, name
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, session_id, now=T0)  # an ID is not a token
    auth.logout_ca(db, session_id)
    with pytest.raises(auth.SessionInvalid):
        auth.rotate_ca_session(db, session_id, now=T0)
    assert auth.authenticate_ca_session(db, session.token, now=T0)  # untouched


def test_client_sessions_are_not_ca_sessions(db):
    reg = approved(db)
    client = repo.get_or_create_client_identity(db, repo.FirmScope(reg.firm_id), "client@example.test")
    token = "C" * 43
    repo.create_session(db, kind="client", firm_id=reg.firm_id, client_identity_id=client["id"],
                        token_hash=hashlib.sha256(token.encode()).hexdigest(),
                        idle_expires_at="2999-01-01T00:00:00.000000Z", absolute_expires_at="2999-01-01T00:00:00.000000Z")
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, token, now=T0)


# === cross-firm isolation ======================================================================================

def test_principals_and_sessions_are_isolated_per_firm(db):
    a, b = approved(db, "a"), approved(db, "b")
    sa, sb = login(db, "a"), login(db, "b")
    pa = auth.authenticate_ca_session(db, sa.token, now=T0)
    pb = auth.authenticate_ca_session(db, sb.token, now=T0)
    assert (pa.firm_id, pb.firm_id) == (a.firm_id, b.firm_id) and pa.scope != pb.scope
    with pytest.raises(repo.NotFound):
        repo.get_ca_user(db, pa.scope, b.user_id)  # the derived scope cannot read the other firm
    auth.admin_deactivate_ca_user(db, firm_id=a.firm_id, user_id=a.user_id)
    auth.admin_suspend_firm(db, firm_id=a.firm_id)
    assert auth.authenticate_ca_session(db, sb.token, now=T0).firm_id == b.firm_id
    with pytest.raises(repo.NotFound):  # deactivation is scoped to the firm given
        auth.admin_deactivate_ca_user(db, firm_id=a.firm_id, user_id=b.user_id)
    assert auth.authenticate_ca_session(db, sb.token, now=T0)


def test_scope_comes_from_the_database_not_the_caller(db):
    approved(db, "a")
    params = set()
    for fn in (auth.login_ca, auth.authenticate_ca_session, auth.rotate_ca_session, auth.logout_ca):
        params |= set(inspect.signature(fn).parameters)
    assert "firm_id" not in params and "scope" not in params


def test_secrets_never_appear_in_output_or_reprs(db, capsys):
    approved(db)
    result = login(db)
    assert result.token not in repr(result) and "<redacted>" in repr(result)
    auth.logout_ca(db, result.token)
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""


def test_cookie_policy_for_later_routes():
    policy = auth.CA_SESSION_COOKIE
    assert policy.http_only and policy.same_site == "lax" and policy.path == "/"
    assert policy.secure(production=True) and not policy.secure(production=False)
    assert policy.cookie_name(production=True).startswith("__Host-")
    assert policy.max_age_seconds == 12 * 3600
