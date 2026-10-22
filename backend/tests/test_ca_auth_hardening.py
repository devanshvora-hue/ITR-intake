"""Stage 5.3A: password reset, challenge replacement, lockout under
concurrency, session lifecycle, timing work. Temporary databases and
synthetic records only; no network."""

import hashlib
import threading
from datetime import UTC, datetime, timedelta

import pytest

import itr_intake_server.ca_auth as auth
import itr_intake_server.repository as repo
from itr_intake_server.db import connect, initialize_database

PASSWORD = "synthetic-pass-9481"
NEW_PASSWORD = "synthetic-new-pass-5273"
T0 = datetime(2025, 7, 1, 9, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def fast_scrypt(monkeypatch):
    monkeypatch.setattr(auth, "SCRYPT_N", 2**10)


@pytest.fixture
def db_path(tmp_path):
    path = tmp_path / "hardening.db"
    initialize_database(path).close()
    return path


@pytest.fixture
def db(db_path):
    conn = connect(db_path)
    yield conn
    conn.close()


def approved(db, tag="a"):
    reg = auth.register_ca(db, full_name=f"CA {tag} (synthetic)", email=f"ca-{tag}@example.test", password=PASSWORD,
                           firm_name=f"Firm {tag} (synthetic)")
    auth.confirm_email(db, auth.start_email_verification(db, reg.user_id, now=T0), now=T0)
    auth.admin_approve_ca(db, firm_id=reg.firm_id, user_id=reg.user_id, approved_by="operator")
    return reg


def login(db, tag="a", password=PASSWORD, now=T0):
    return auth.login_ca(db, f"ca-{tag}@example.test", password, now=now)


def live_sessions(db, user_id):
    return db.execute("SELECT count(*) FROM sessions WHERE ca_user_id = ? AND revoked_at IS NULL", (user_id,)).fetchone()[0]


# === 1. password reset =========================================================================

@pytest.mark.parametrize("email", ["nobody@example.test", "not an email", "", None, 42])
def test_reset_request_for_unknown_or_malformed_email_is_silent(db, email):
    approved(db)
    result = auth.request_password_reset(db, email, now=T0)
    assert result.should_send is False and result.token is None and result.email is None
    assert db.execute("SELECT count(*) FROM verification_challenges WHERE purpose = 'ca_password_reset'").fetchone()[0] == 0


def test_reset_request_for_disabled_account_is_silent(db):
    reg = approved(db)
    auth.admin_deactivate_ca_user(db, firm_id=reg.firm_id, user_id=reg.user_id)
    assert auth.request_password_reset(db, "ca-a@example.test", now=T0).should_send is False


def test_reset_request_stores_only_a_hash(db):
    approved(db)
    result = auth.request_password_reset(db, "CA-A@Example.test", now=T0)
    assert result.should_send and result.email == "ca-a@example.test"
    assert result.token not in repr(result) and "should_send=True" in repr(result)
    secret = result.token.split(".")[1]
    stored = db.execute("SELECT secret_hash, max_attempts, expires_at FROM verification_challenges "
                        "WHERE purpose = 'ca_password_reset'").fetchone()
    assert secret not in stored[0] and stored[0] == hashlib.sha256(secret.encode()).hexdigest()
    assert stored[1] == auth.PASSWORD_RESET_ATTEMPTS
    assert stored[2] == "2025-07-01T09:30:00.000000Z"


def test_valid_reset_changes_password_and_revokes_all_sessions(db):
    reg, other = approved(db, "a"), approved(db, "b")
    login(db), login(db)
    other_session = login(db, "b")
    for _ in range(3):
        with pytest.raises(auth.AuthenticationFailed):
            login(db, password="wrong-password-123")
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0 + timedelta(minutes=5))
    assert live_sessions(db, reg.user_id) == 0
    assert db.execute("SELECT failed_logins, locked_until FROM ca_users WHERE id = ?", (reg.user_id,)).fetchone()[:] == (0, None)
    with pytest.raises(auth.AuthenticationFailed):
        login(db, password=PASSWORD)
    assert login(db, password=NEW_PASSWORD).principal.user_id == reg.user_id
    assert auth.authenticate_ca_session(db, other_session.token, now=T0).user_id == other.user_id  # untouched


def test_reset_does_not_activate_a_pending_account(db):
    auth.register_ca(db, full_name="Pending (synthetic)", email="pending@example.test", password=PASSWORD,
                     firm_name="Pending Firm (synthetic)")
    token = auth.request_password_reset(db, "pending@example.test", now=T0).token
    auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0)
    with pytest.raises(auth.AuthenticationFailed):
        auth.login_ca(db, "pending@example.test", NEW_PASSWORD, now=T0)
    assert db.execute("SELECT status FROM ca_users").fetchone()[0] == "pending"


def test_reset_secret_is_single_use(db):
    approved(db)
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0)
    with pytest.raises(auth.PasswordResetFailed):
        auth.confirm_password_reset(db, token, "another-new-pass-8812", now=T0)
    assert login(db, password=NEW_PASSWORD)


def test_expired_reset_secret(db):
    approved(db)
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    with pytest.raises(auth.PasswordResetFailed):
        auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0 + auth.PASSWORD_RESET_TTL)
    assert login(db, password=PASSWORD)


@pytest.mark.parametrize("make_bad", [
    lambda t: None, lambda t: "", lambda t: "no-dot-at-all", lambda t: t.split(".")[0] + ".short",
    lambda t: t + ".extra", lambda t: "not-a-uuid." + t.split(".")[1], lambda t: t.replace(".", ":"),
])
def test_malformed_reset_secrets(db, make_bad):
    approved(db)
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    with pytest.raises(auth.PasswordResetFailed) as info:
        auth.confirm_password_reset(db, make_bad(token), NEW_PASSWORD, now=T0)
    assert str(info.value) == "Reset link is invalid or has expired."


def test_incorrect_reset_secrets_count_and_run_out(db):
    approved(db)
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    challenge_id = token.split(".")[0]
    wrong = f"{challenge_id}.{'A' * 43}"
    for n in range(1, auth.PASSWORD_RESET_ATTEMPTS + 1):
        with pytest.raises(auth.PasswordResetFailed):
            auth.confirm_password_reset(db, wrong, NEW_PASSWORD, now=T0)
        assert repo.get_challenge(db, challenge_id)["attempts"] == n
    with pytest.raises(auth.PasswordResetFailed):  # the right secret no longer works
        auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0)
    assert login(db, password=PASSWORD)


def test_policy_failure_does_not_spend_the_reset_secret(db):
    approved(db)
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    with pytest.raises(auth.RegistrationError, match="password_too_short"):
        auth.confirm_password_reset(db, token, "short", now=T0)
    assert repo.get_challenge(db, token.split(".")[0])["attempts"] == 0
    auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0)


def test_reset_and_verification_tokens_are_not_interchangeable(db):
    reg = approved(db)
    verify_token = auth.start_email_verification(db, reg.user_id, now=T0)
    with pytest.raises(auth.PasswordResetFailed):
        auth.confirm_password_reset(db, verify_token, NEW_PASSWORD, now=T0)
    reset_token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    with pytest.raises(auth.VerificationFailed):
        auth.confirm_email(db, reset_token, now=T0)


def test_reset_refused_if_account_disabled_after_request(db):
    reg = approved(db)
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    auth.admin_deactivate_ca_user(db, firm_id=reg.firm_id, user_id=reg.user_id)
    with pytest.raises(auth.PasswordResetFailed):
        auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0)


def test_new_reset_request_supersedes_the_old_one(db):
    approved(db)
    old = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    new = auth.request_password_reset(db, "ca-a@example.test", now=T0 + timedelta(minutes=1)).token
    with pytest.raises(auth.PasswordResetFailed):
        auth.confirm_password_reset(db, old, NEW_PASSWORD, now=T0 + timedelta(minutes=2))
    auth.confirm_password_reset(db, new, NEW_PASSWORD, now=T0 + timedelta(minutes=2))


# === 2. verification-challenge replacement ======================================================

def test_new_verification_token_supersedes_the_old_one(db):
    reg = auth.register_ca(db, full_name="CA (synthetic)", email="ca-a@example.test", password=PASSWORD,
                           firm_name="Firm (synthetic)")
    old = auth.start_email_verification(db, reg.user_id, now=T0)
    old_id = old.split(".")[0]
    with pytest.raises(auth.VerificationFailed):
        auth.confirm_email(db, f"{old_id}.{'B' * 43}", now=T0)  # one failed attempt on the old token
    new = auth.start_email_verification(db, reg.user_id, now=T0 + timedelta(minutes=1))
    assert repo.get_challenge(db, old_id)["attempts"] == 1  # history kept
    with pytest.raises(auth.VerificationFailed):
        auth.confirm_email(db, old, now=T0 + timedelta(minutes=2))
    new_id = new.split(".")[0]
    for n in (1, 2):  # failed attempts on the replacement still count
        with pytest.raises(auth.VerificationFailed):
            auth.confirm_email(db, f"{new_id}.{'C' * 43}", now=T0 + timedelta(minutes=2))
        assert repo.get_challenge(db, new_id)["attempts"] == n
    auth.confirm_email(db, new, now=T0 + timedelta(minutes=2))
    assert db.execute("SELECT email_verified_at FROM ca_users").fetchone()[0] is not None


def test_supersession_is_limited_to_the_same_account_and_purpose(db):
    a = auth.register_ca(db, full_name="A (synthetic)", email="a@example.test", password=PASSWORD, firm_name="A (synthetic)")
    b = auth.register_ca(db, full_name="B (synthetic)", email="b@example.test", password=PASSWORD, firm_name="B (synthetic)")
    reset_a = auth.request_password_reset(db, "a@example.test", now=T0).token
    verify_b = auth.start_email_verification(db, b.user_id, now=T0)
    auth.start_email_verification(db, a.user_id, now=T0)  # supersedes only A's verification challenges
    auth.confirm_email(db, verify_b, now=T0)
    auth.confirm_password_reset(db, reset_a, NEW_PASSWORD, now=T0)


def test_issuing_a_challenge_is_atomic(db, monkeypatch):
    reg = auth.register_ca(db, full_name="CA (synthetic)", email="ca-a@example.test", password=PASSWORD,
                           firm_name="Firm (synthetic)")
    first = auth.start_email_verification(db, reg.user_id, now=T0)

    def failing_create(*args, **kwargs):
        raise repo.InvalidInput("challenge")

    monkeypatch.setattr(repo, "create_challenge", failing_create)
    with pytest.raises(repo.InvalidInput):
        auth.start_email_verification(db, reg.user_id, now=T0)
    monkeypatch.undo()
    auth.confirm_email(db, first, now=T0)  # the supersede step was rolled back


# === 3. lockout under concurrency ====================================================================

def test_concurrent_failure_counter_updates_are_not_lost(db_path, db):
    reg = approved(db)
    threads, per_thread = 8, 25
    barrier = threading.Barrier(threads)
    errors = []

    def worker():
        conn = connect(db_path)
        try:
            barrier.wait()
            for _ in range(per_thread):
                repo.record_ca_login_failure(conn, reg.user_id, max_failures=10_000,
                                             locked_until="2999-01-01T00:00:00.000000Z")
        except Exception as exc:  # pragma: no cover - reported below
            errors.append(type(exc).__name__)
        finally:
            conn.close()

    workers = [threading.Thread(target=worker) for _ in range(threads)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    assert errors == []
    assert db.execute("SELECT failed_logins FROM ca_users WHERE id = ?", (reg.user_id,)).fetchone()[0] == threads * per_thread


def test_concurrent_failed_logins_all_count_and_lock(db_path, db):
    reg = approved(db)
    threads, per_thread = 6, 3
    barrier = threading.Barrier(threads)
    outcomes = []

    def worker():
        conn = connect(db_path)
        try:
            barrier.wait()
            for _ in range(per_thread):
                try:
                    auth.login_ca(conn, "ca-a@example.test", "wrong-password-123", now=T0)
                except auth.AuthenticationFailed:
                    outcomes.append("failed")
        finally:
            conn.close()

    workers = [threading.Thread(target=worker) for _ in range(threads)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    assert outcomes == ["failed"] * (threads * per_thread)
    failed, locked = db.execute("SELECT failed_logins, locked_until FROM ca_users WHERE id = ?", (reg.user_id,)).fetchone()
    assert failed == threads * per_thread and locked is not None
    with pytest.raises(auth.AuthenticationFailed):
        login(db, now=T0 + timedelta(minutes=1))


def test_failure_window_restarts_after_a_lock_expires(db):
    reg = approved(db)
    for _ in range(auth.MAX_FAILED_LOGINS):
        with pytest.raises(auth.AuthenticationFailed):
            login(db, password="wrong-password-123")
    after = T0 + auth.LOCKOUT + timedelta(seconds=1)
    with pytest.raises(auth.AuthenticationFailed):
        login(db, password="wrong-password-123", now=after)
    failed, locked = db.execute("SELECT failed_logins, locked_until FROM ca_users WHERE id = ?", (reg.user_id,)).fetchone()
    assert (failed, locked) == (1, None)  # previously: an immediate re-lock
    assert login(db, now=after)


def test_lockout_is_still_an_account_level_denial_of_service_risk(db):
    """Documents the remaining risk: anyone who knows a CA's e-mail can lock
    that account for LOCKOUT by failing MAX_FAILED_LOGINS times. Trusted-proxy-
    aware IP rate limiting must be added and tested with the HTTP routes."""
    approved(db)
    for _ in range(auth.MAX_FAILED_LOGINS):
        with pytest.raises(auth.AuthenticationFailed):
            auth.login_ca(db, "ca-a@example.test", "attacker-guess-0001", now=T0)
    with pytest.raises(auth.AuthenticationFailed):
        login(db, now=T0 + timedelta(minutes=1))  # the real owner is locked out


# === 4. session lifecycle =================================================================================

def test_rotation_never_extends_absolute_expiry(db):
    approved(db)
    session = login(db)
    absolute = session.principal.absolute_expires_at
    token, moment = session.token, T0
    for _ in range(20):
        moment += timedelta(minutes=29)
        if moment >= T0 + auth.CA_SESSION_ABSOLUTE:
            break
        rotated = auth.rotate_ca_session(db, token, now=moment)
        assert rotated.principal.absolute_expires_at == absolute
        assert rotated.principal.idle_expires_at <= absolute
        token = rotated.token
    with pytest.raises(auth.SessionInvalid):  # rotation cannot outlive the original absolute expiry
        auth.rotate_ca_session(db, token, now=T0 + auth.CA_SESSION_ABSOLUTE)


def test_idle_expiry_and_hashing_still_hold(db):
    approved(db)
    session = login(db)
    assert db.execute("SELECT count(*) FROM sessions WHERE token_hash = ?",
                      (hashlib.sha256(session.token.encode()).hexdigest(),)).fetchone()[0] == 1
    with pytest.raises(auth.SessionInvalid):
        auth.authenticate_ca_session(db, session.token, now=T0 + auth.CA_SESSION_IDLE)


def test_firm_suspension_and_user_deactivation_revoke_sessions(db):
    a, b = approved(db, "a"), approved(db, "b")
    login(db, "a"), login(db, "b")
    auth.admin_deactivate_ca_user(db, firm_id=a.firm_id, user_id=a.user_id)
    assert live_sessions(db, a.user_id) == 0 and live_sessions(db, b.user_id) == 1
    auth.admin_suspend_firm(db, firm_id=b.firm_id)
    assert live_sessions(db, b.user_id) == 0


# === 5. timing work and errors ============================================================================

def count_scrypt(monkeypatch):
    calls = []
    real = auth.hashlib.scrypt
    monkeypatch.setattr(auth.hashlib, "scrypt", lambda *a, **k: calls.append(1) or real(*a, **k))
    return calls


@pytest.mark.parametrize("case", ["unknown email", "wrong password", "right password", "malformed stored hash",
                                  "non-string password", "oversized password"])
def test_every_login_path_runs_exactly_one_scrypt(db, monkeypatch, case):
    reg = approved(db)
    if case == "malformed stored hash":
        db.execute("UPDATE ca_users SET password_hash = 'corrupted' WHERE id = ?", (reg.user_id,))
    email = "nobody@example.test" if case == "unknown email" else "ca-a@example.test"
    password = {"wrong password": "wrong-password-123", "non-string password": None,
                "oversized password": "x" * 10_000}.get(case, PASSWORD)
    calls = count_scrypt(monkeypatch)
    try:
        auth.login_ca(db, email, password, now=T0)
    except auth.AuthenticationFailed as exc:
        assert str(exc) == "Invalid email or password."
    assert calls == [1], case


def test_dummy_check_costs_no_extra_hash_on_first_use(monkeypatch):
    calls = count_scrypt(monkeypatch)
    assert auth._check_password(PASSWORD, None) is False
    assert calls == [1]


def test_reset_and_verification_flows_print_nothing(db, capsys):
    reg = approved(db)
    auth.start_email_verification(db, reg.user_id, now=T0)
    token = auth.request_password_reset(db, "ca-a@example.test", now=T0).token
    auth.confirm_password_reset(db, token, NEW_PASSWORD, now=T0)
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""
