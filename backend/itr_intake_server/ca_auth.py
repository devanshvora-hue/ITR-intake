"""CA authentication: registration, e-mail verification, operator approval,
login, server-side sessions and logout.

Lifecycle
---------
register_ca          firm 'pending_verification', user 'pending'. No firm code.
confirm_email        user e-mail verified; firm -> 'pending_approval'.
                     Verification proves control of the address only; it never
                     activates anything.
admin_approve_ca     operator-only: requires a verified e-mail; firm 'active',
                     user 'active'. Still issues no firm code (Stage 5.5).
login_ca             only an active, verified user of an active firm succeeds.
admin_deactivate_ca_user / admin_suspend_firm revoke the affected sessions.

Login failures all raise the same `AuthenticationFailed` with the same
message, whether the e-mail is unknown, the password is wrong, the account is
pending, disabled or locked, or the firm is inactive. A hash is always
computed, so unknown e-mails take about as long as known ones.

Sessions
--------
The raw token (`secrets.token_urlsafe(32)`, 256 bits) is returned to the
caller exactly once and is never stored: the database holds only its SHA-256
hex digest. Every operation on a session starts from a presented token:
hash it, look the session up by hash, check kind, expiry, user and firm, then
act on that session. No function accepts a session ID from a caller.
CA sessions expire after 30 minutes idle or 12 hours absolute, whichever
comes first. Login always issues a new token and revokes any session the
caller presents (rotation). The principal's firm scope comes from the
database-backed account, never from request data.

HTTP boundary (later stages)
----------------------------
`CA_SESSION_COOKIE` describes how routes must carry the token: HttpOnly,
SameSite=Lax, Path=/, Secure in production (with the __Host- prefix). No
routes or cookies are created here.

Nothing in this module logs or prints passwords, tokens, secrets or rows.
"""

import base64
import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from . import repository as repo
from .ids import normalise_email
from .repository import FirmScope, NotFound

# --- settings --------------------------------------------------------------------

SCRYPT_N = 2**15  # project setting (agreed "scrypt" approach); ~0.1 s per hash here
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SCRYPT_SALT_BYTES = 16
_SCRYPT_MAXMEM = 128 * 1024 * 1024

PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 256

CA_SESSION_IDLE = timedelta(minutes=30)
CA_SESSION_ABSOLUTE = timedelta(hours=12)
MAX_FAILED_LOGINS = 10
LOCKOUT = timedelta(minutes=15)

EMAIL_VERIFICATION_TTL = timedelta(hours=24)
EMAIL_VERIFICATION_ATTEMPTS = 5
PASSWORD_RESET_TTL = timedelta(minutes=30)
PASSWORD_RESET_ATTEMPTS = 5

_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")  # secrets.token_urlsafe(32)
_COMMON_PASSWORDS = frozenset({
    "password1234", "123456789012", "qwertyuiop12", "passwordpassword", "letmein12345", "welcome12345",
    "iloveyou1234", "admin1234567", "changeme1234", "itrintake123",
})


@dataclass(frozen=True)
class CookiePolicy:
    """How HTTP routes must set the CA session cookie (not used here)."""

    name: str
    production_name: str
    http_only: bool
    same_site: str
    path: str
    max_age_seconds: int

    def secure(self, production: bool) -> bool:
        return production

    def cookie_name(self, production: bool) -> str:
        return self.production_name if production else self.name


CA_SESSION_COOKIE = CookiePolicy(
    name="itr_ca_session",
    production_name="__Host-itr_ca_session",
    http_only=True,
    same_site="lax",
    path="/",
    max_age_seconds=int(CA_SESSION_ABSOLUTE.total_seconds()),
)

# --- errors ------------------------------------------------------------------------


class AuthError(Exception):
    """Base class; messages are safe to show and reveal no account state."""


class AuthenticationFailed(AuthError):
    def __init__(self) -> None:
        super().__init__("Invalid email or password.")


class SessionInvalid(AuthError):
    def __init__(self) -> None:
        super().__init__("Session is invalid or has expired.")


class RegistrationError(AuthError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"Registration could not be completed ({code}).")


class VerificationFailed(AuthError):
    def __init__(self) -> None:
        super().__init__("Verification link is invalid or has expired.")


class ApprovalError(AuthError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"Approval refused ({code}).")


# --- time helpers -------------------------------------------------------------------


def _now(now: datetime | None) -> datetime:
    value = now or datetime.now(UTC)
    if value.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    return value.astimezone(UTC)


def _stamp(value: datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(stamp: str) -> datetime:
    return datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)


# --- passwords -------------------------------------------------------------------------


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def check_password_policy(password: object) -> str:
    """Raise RegistrationError if the password is unacceptable."""
    if not isinstance(password, str):
        raise RegistrationError("password_invalid")
    if len(password) < PASSWORD_MIN_LENGTH:
        raise RegistrationError("password_too_short")
    if len(password) > PASSWORD_MAX_LENGTH:
        raise RegistrationError("password_too_long")
    if len(set(password)) < 4 or password.lower() in _COMMON_PASSWORDS:
        raise RegistrationError("password_too_common")
    return password


def hash_password(password: str) -> str:
    """'scrypt$N$r$p$<salt>$<hash>' with a random 16-byte salt."""
    salt = secrets.token_bytes(SCRYPT_SALT_BYTES)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
                            maxmem=_SCRYPT_MAXMEM, dklen=SCRYPT_DKLEN)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(salt)}${_b64(digest)}"


_HASH_FORMAT = re.compile(r"^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$")


def _verify(password: object, stored: object) -> tuple[bool, bool]:
    """(matches, scrypt_ran). Never raises."""
    if not isinstance(password, str) or not isinstance(stored, str):
        return False, False
    m = _HASH_FORMAT.match(stored)
    if not m:
        return False, False
    n, r, p = int(m[1]), int(m[2]), int(m[3])
    if n < 2 or n & (n - 1) or n > 2**20 or not 1 <= r <= 32 or not 1 <= p <= 16:
        return False, False
    try:
        salt, expected = _unb64(m[4]), _unb64(m[5])
        if not salt or not expected or len(password) > PASSWORD_MAX_LENGTH:
            return False, False
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=_SCRYPT_MAXMEM,
                                dklen=len(expected))
    except (ValueError, MemoryError):
        return False, False
    return hmac.compare_digest(actual, expected), True


def verify_password(password: object, stored: object) -> bool:
    """Constant-time check of a password against a stored scrypt hash.
    Malformed or out-of-range stored values verify as False (never raise)."""
    return _verify(password, stored)[0]


def _dummy_hash() -> str:
    """A well-formed hash at the current parameters that matches nothing. It
    costs nothing to build; verifying against it costs one full scrypt run."""
    return (f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64(secrets.token_bytes(SCRYPT_SALT_BYTES))}"
            f"${_b64(bytes(SCRYPT_DKLEN))}")


def _check_password(password: object, stored: object | None) -> bool:
    """Verify a login password while always spending one scrypt run, even for
    an unknown account, a malformed stored hash or a non-string password, so
    those cases are not distinguishable by a fast reply."""
    matches, ran = _verify(password, stored) if stored is not None else (False, False)
    if not ran:
        candidate = password if isinstance(password, str) and len(password) <= PASSWORD_MAX_LENGTH else ""
        _verify(candidate, _dummy_hash())
    return matches


def _burn_password_check(password: object) -> None:
    """Spend the same work as a real check when there is no account."""
    _check_password(password, None)


# --- tokens --------------------------------------------------------------------------------


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def _valid_token(token: object) -> bool:
    return isinstance(token, str) and bool(_TOKEN.match(token))


# --- registration and e-mail verification ---------------------------------------------------


@dataclass(frozen=True)
class Registration:
    firm_id: str
    user_id: str
    email: str


def register_ca(conn, *, full_name: str, email: str, password: str, firm_name: str,
                contact_phone: str | None = None, contact_address: str | None = None,
                registration_number: str | None = None) -> Registration:
    """Create a pending firm and its pending owner account, atomically.

    Nothing becomes usable: the firm is 'pending_verification', the user is
    'pending', and no firm code is issued. Duplicates raise
    RegistrationError('email_taken' | 'registration_number_taken'); HTTP
    routes should answer such duplicates generically.
    """
    check_password_policy(password)
    try:
        email_norm = normalise_email(email)
    except ValueError:
        raise RegistrationError("email_invalid") from None
    password_hash = hash_password(password)
    try:
        with repo._atomic(conn):
            firm = repo.create_firm(conn, name=firm_name, contact_phone=contact_phone,
                                    contact_address=contact_address, registration_number=registration_number)
            user = repo.create_ca_user(conn, firm_id=firm["id"], email=email_norm, full_name=full_name,
                                       password_hash=password_hash, role="owner")
    except repo.Conflict as exc:
        raise RegistrationError(exc.code) from None
    except repo.InvalidInput as exc:
        raise RegistrationError(f"{exc.field}_invalid") from None
    return Registration(firm["id"], user["id"], email_norm)


def start_email_verification(conn, registration_user_id: str, *, now: datetime | None = None) -> str:
    """Issue an e-mail verification token for a pending user and return it
    (to be e-mailed in a later stage). Only its hash is stored."""
    moment = _now(now)
    user = _user_unscoped(conn, registration_user_id)
    return _issue_challenge(conn, purpose="ca_email_verification", user=user, moment=moment,
                            ttl=EMAIL_VERIFICATION_TTL, attempts=EMAIL_VERIFICATION_ATTEMPTS)


def _issue_challenge(conn, *, purpose: str, user: dict, moment: datetime, ttl: timedelta, attempts: int) -> str:
    """Atomically end any outstanding challenge of this purpose for the user
    and issue a new one. Returns "<challenge_id>.<secret>"; only the secret's
    SHA-256 is stored."""
    secret = secrets.token_urlsafe(32)
    with repo._atomic(conn):
        repo.supersede_challenges(conn, purpose=purpose, ca_user_id=user["id"], now=_stamp(moment))
        challenge = repo.create_challenge(
            conn, purpose=purpose, subject=user["id"], secret_hash=_token_hash(secret), max_attempts=attempts,
            expires_at=_stamp(moment + ttl), firm_id=user["firm_id"], ca_user_id=user["id"],
        )
    return f"{challenge['id']}.{secret}"


def _redeem_challenge(conn, token: object, *, purpose: str, moment: datetime) -> dict:
    """Check a "<challenge_id>.<secret>" token for `purpose` and count the
    attempt (committed on its own, so a wrong secret still uses one up).
    Returns the challenge when the secret matches; the caller must then
    consume it inside its own transaction. Raises VerificationFailed."""
    if not isinstance(token, str) or token.count(".") != 1:
        raise VerificationFailed()
    challenge_id, secret = token.split(".")
    if not _valid_token(secret):
        raise VerificationFailed()
    try:
        ch = repo.get_challenge(conn, challenge_id)
    except NotFound:
        raise VerificationFailed() from None
    if ch["purpose"] != purpose or ch["consumed_at"] is not None or _parse(ch["expires_at"]) <= moment:
        raise VerificationFailed()
    try:
        repo.record_challenge_attempt(conn, ch["id"])
    except repo.Conflict:
        raise VerificationFailed() from None
    if not hmac.compare_digest(_token_hash(secret), ch["secret_hash"]):
        raise VerificationFailed()
    return ch


def confirm_email(conn, token: str, *, now: datetime | None = None) -> None:
    """Verify a CA's e-mail from a verification token. Marks the e-mail
    verified and moves a 'pending_verification' firm to 'pending_approval'.
    Never approves or activates. Any problem raises VerificationFailed."""
    moment = _now(now)
    ch = _redeem_challenge(conn, token, purpose="ca_email_verification", moment=moment)
    with repo._atomic(conn):
        if not repo.consume_challenge(conn, ch["id"]):  # single use, even under a race
            raise VerificationFailed()
        scope = FirmScope(ch["firm_id"])
        repo.mark_ca_user_email_verified(conn, scope, ch["ca_user_id"])
        if repo.get_firm(conn, scope)["status"] == "pending_verification":
            repo.admin_set_firm_status(conn, scope.firm_id, "pending_approval")


# --- password reset ------------------------------------------------------------------------------


@dataclass(frozen=True)
class PasswordResetRequest:
    """Outcome of a reset request, for a future e-mail outbox step.

    The HTTP route must give the requester the same response whether or not
    `token` is set, so the result never reveals whether the e-mail exists.
    When set, `token` goes into the e-mail only and must not be logged.
    """

    email: str | None
    token: str | None

    @property
    def should_send(self) -> bool:
        return self.token is not None

    def __repr__(self) -> str:
        return f"PasswordResetRequest(should_send={self.should_send})"


class PasswordResetFailed(AuthError):
    def __init__(self) -> None:
        super().__init__("Reset link is invalid or has expired.")


def request_password_reset(conn, email: object, *, now: datetime | None = None) -> PasswordResetRequest:
    """Issue a reset token for a CA account that may still sign in (not
    disabled). Any earlier outstanding reset token for that account is ended.
    Unknown, malformed and disabled e-mails get an empty result instead of an
    error, so callers can respond identically."""
    moment = _now(now)
    try:
        user = repo.get_ca_user_for_login(conn, email if isinstance(email, str) else "")
    except NotFound:
        return PasswordResetRequest(None, None)
    if user["status"] == "disabled":
        return PasswordResetRequest(None, None)
    token = _issue_challenge(conn, purpose="ca_password_reset", user=user, moment=moment,
                             ttl=PASSWORD_RESET_TTL, attempts=PASSWORD_RESET_ATTEMPTS)
    return PasswordResetRequest(user["email_norm"], token)


def confirm_password_reset(conn, token: str, new_password: str, *, now: datetime | None = None) -> None:
    """Set a new password from a reset token, then revoke every session of the
    account and clear its failed-login lock.

    The token is single-use, expires after PASSWORD_RESET_TTL and allows
    PASSWORD_RESET_ATTEMPTS tries. A reset never activates a pending account
    and is refused for a disabled one. The new password is checked against
    the policy before the token is touched (RegistrationError on failure);
    token problems raise PasswordResetFailed.
    """
    moment = _now(now)
    check_password_policy(new_password)
    try:
        ch = _redeem_challenge(conn, token, purpose="ca_password_reset", moment=moment)
    except VerificationFailed:
        raise PasswordResetFailed() from None
    new_hash = hash_password(new_password)
    scope = FirmScope(ch["firm_id"])
    with repo._atomic(conn):
        user = repo.get_ca_user(conn, scope, ch["ca_user_id"])
        if user["status"] == "disabled" or not repo.consume_challenge(conn, ch["id"]):
            raise PasswordResetFailed()
        repo.set_ca_user_password_hash(conn, scope, user["id"], new_hash)
        repo.reset_ca_login_failures(conn, user["id"])
        repo.revoke_ca_user_sessions(conn, scope, user["id"])


def _user_unscoped(conn, user_id: str) -> dict:
    row = conn.execute("SELECT id, firm_id FROM ca_users WHERE id = ?", (repo._id(user_id),)).fetchone()
    if row is None:
        raise NotFound()
    return dict(row)


# --- operator approval and deactivation -------------------------------------------------------


def admin_approve_ca(conn, *, firm_id: str, user_id: str, approved_by: str) -> None:
    """Operator-only approval (command line / trusted admin tooling; there is
    no public endpoint). Requires the user's e-mail to be verified. Activates
    the firm and the user; issues no firm code."""
    if not isinstance(approved_by, str) or not approved_by.strip():
        raise ApprovalError("approver_required")
    scope = FirmScope(firm_id)
    with repo._atomic(conn):
        try:
            user = repo.get_ca_user(conn, scope, user_id)
            firm = repo.get_firm(conn, scope)
        except NotFound:
            raise ApprovalError("not_found") from None
        if user["email_verified_at"] is None:
            raise ApprovalError("email_not_verified")
        if user["status"] == "disabled" or firm["status"] == "suspended":
            raise ApprovalError("account_disabled")
        repo.admin_set_firm_status(conn, scope.firm_id, "active", approved_by=approved_by)
        repo.set_ca_user_status(conn, scope, user["id"], "active")


def admin_deactivate_ca_user(conn, *, firm_id: str, user_id: str) -> int:
    """Operator-only: disable a CA user and revoke all of their sessions.
    Returns the number of sessions revoked."""
    scope = FirmScope(firm_id)
    with repo._atomic(conn):
        repo.set_ca_user_status(conn, scope, user_id, "disabled")
        return repo.revoke_ca_user_sessions(conn, scope, user_id)


def admin_suspend_firm(conn, *, firm_id: str) -> int:
    """Operator-only: suspend a firm and revoke every session of that firm."""
    scope = FirmScope(firm_id)
    with repo._atomic(conn):
        repo.admin_set_firm_status(conn, scope.firm_id, "suspended")
        return repo.revoke_firm_sessions(conn, scope)


# --- login, sessions and logout ----------------------------------------------------------------


@dataclass(frozen=True)
class CaPrincipal:
    """An authenticated CA. `scope` is derived from the database-backed
    account and firm, never from request data."""

    user_id: str
    firm_id: str
    role: str
    email: str
    full_name: str
    idle_expires_at: str
    absolute_expires_at: str

    @property
    def scope(self) -> FirmScope:
        return FirmScope(self.firm_id)


@dataclass(frozen=True)
class LoginResult:
    token: str  # give to the client once (cookie); never store or log it
    principal: CaPrincipal

    def __repr__(self) -> str:  # keep the token out of reprs and tracebacks
        return f"LoginResult(token=<redacted>, principal={self.principal!r})"


def _account_usable(user: dict, firm: dict, moment: datetime) -> bool:
    return (user["status"] == "active" and user["email_verified_at"] is not None and firm["status"] == "active"
            and (user["locked_until"] is None or _parse(user["locked_until"]) <= moment))


def login_ca(conn, email: str, password: str, *, previous_token: str | None = None,
             now: datetime | None = None) -> LoginResult:
    """Authenticate a CA and open a new session.

    Any failure raises AuthenticationFailed with one generic message. Wrong
    passwords count towards a temporary lock. On success a fresh token is
    issued and `previous_token`, if presented, is revoked (rotation).
    """
    moment = _now(now)
    try:
        user = repo.get_ca_user_for_login(conn, email if isinstance(email, str) else "")
    except NotFound:
        _burn_password_check(password)
        raise AuthenticationFailed() from None
    password_ok = _check_password(password, user["password_hash"])
    firm = repo.get_firm(conn, FirmScope(user["firm_id"]))
    if not password_ok:
        # One atomic relative UPDATE: concurrent failures are all counted.
        repo.record_ca_login_failure(conn, user["id"], max_failures=MAX_FAILED_LOGINS,
                                     locked_until=_stamp(moment + LOCKOUT), now=_stamp(moment))
        raise AuthenticationFailed()
    if not _account_usable(user, firm, moment):
        raise AuthenticationFailed()

    token = secrets.token_urlsafe(32)
    with repo._atomic(conn):
        if previous_token is not None:
            _revoke_presented(conn, previous_token)
        repo.reset_ca_login_failures(conn, user["id"])
        repo.create_session(
            conn, kind="ca", firm_id=user["firm_id"], ca_user_id=user["id"], token_hash=_token_hash(token),
            idle_expires_at=_stamp(min(moment + CA_SESSION_IDLE, moment + CA_SESSION_ABSOLUTE)),
            absolute_expires_at=_stamp(moment + CA_SESSION_ABSOLUTE),
        )
    return LoginResult(token, authenticate_ca_session(conn, token, now=moment))


def _session_for_token(conn, token: object) -> dict:
    """The non-revoked CA session for a presented token, or SessionInvalid."""
    if not _valid_token(token):
        raise SessionInvalid()
    try:
        session = repo.get_session_by_token_hash(conn, _token_hash(token))
    except NotFound:
        raise SessionInvalid() from None
    if session["kind"] != "ca":
        raise SessionInvalid()
    return session


def authenticate_ca_session(conn, token: str, *, now: datetime | None = None) -> CaPrincipal:
    """Resolve a presented token to a CA principal, sliding the idle timeout.

    Expired sessions, and sessions whose user or firm is no longer usable,
    are revoked and rejected with SessionInvalid. The firm scope is taken
    from the stored session and checked against the stored account.
    """
    moment = _now(now)
    session = _session_for_token(conn, token)
    idle, absolute = _parse(session["idle_expires_at"]), _parse(session["absolute_expires_at"])
    if moment >= idle or moment >= absolute:
        repo.revoke_session(conn, session["id"])
        raise SessionInvalid()
    scope = FirmScope(session["firm_id"])
    try:
        user = repo.get_ca_user(conn, scope, session["ca_user_id"])
        firm = repo.get_firm(conn, scope)
    except NotFound:
        repo.revoke_session(conn, session["id"])
        raise SessionInvalid() from None
    if user["firm_id"] != session["firm_id"] or not _account_usable(user, firm, moment):
        repo.revoke_session(conn, session["id"])
        raise SessionInvalid()
    new_idle = min(moment + CA_SESSION_IDLE, absolute)
    repo.touch_session(conn, session["id"], idle_expires_at=_stamp(new_idle))
    return CaPrincipal(user_id=user["id"], firm_id=user["firm_id"], role=user["role"], email=user["email_norm"],
                       full_name=user["full_name"], idle_expires_at=_stamp(new_idle),
                       absolute_expires_at=session["absolute_expires_at"])


def rotate_ca_session(conn, token: str, *, now: datetime | None = None) -> LoginResult:
    """Replace a valid session's token (e.g. after a privilege change). The
    old token stops working; the absolute expiry is kept."""
    moment = _now(now)
    principal = authenticate_ca_session(conn, token, now=moment)
    old = _session_for_token(conn, token)
    new_token = secrets.token_urlsafe(32)
    with repo._atomic(conn):
        repo.revoke_session(conn, old["id"])
        repo.create_session(conn, kind="ca", firm_id=principal.firm_id, ca_user_id=principal.user_id,
                            token_hash=_token_hash(new_token), idle_expires_at=principal.idle_expires_at,
                            absolute_expires_at=principal.absolute_expires_at)
    return LoginResult(new_token, authenticate_ca_session(conn, new_token, now=moment))


def _revoke_presented(conn, token: object) -> bool:
    try:
        session = _session_for_token(conn, token)
    except SessionInvalid:
        return False
    repo.revoke_session(conn, session["id"])
    return True


def logout_ca(conn, token: str) -> None:
    """Revoke the session for a presented token. Silent if the token is
    unknown, malformed or already revoked (no oracle)."""
    _revoke_presented(conn, token)
