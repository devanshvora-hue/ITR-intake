"""Client onboarding: firm code + e-mail, e-mail verification, client sessions
and case creation (Stage 5.6).

Flow
----
start_client_onboarding  firm code + e-mail. Only an active code of an active
                         firm issues a sign-in challenge; anything else returns
                         an empty result so callers answer identically.
verify_client            redeems the challenge (single use, expiring,
                         attempt-limited), creates or reuses the client identity
                         for that firm and e-mail, and opens a client session.
open_case                opens (or returns) the client's case for a financial year.

Rules
-----
- A client's firm, identity and firm code come only from the server-side
  session. No function accepts a client, firm or case ID from a browser.
- The firm code must still be usable (active code, active firm) when the
  challenge is issued, when it is redeemed, and when a case is opened.
  Revocation therefore stops onboarding at once; existing cases and sessions
  are unaffected, but a session can no longer open new cases with a revoked code.
- A new challenge for the same firm and e-mail supersedes the previous one.
- Client sessions: the raw token is returned once (for an HttpOnly cookie); the
  database stores its SHA-256 only. 30 minutes idle, 12 hours absolute. A
  session dies when its identity disappears or its firm stops being active.
- Nothing here logs; tokens, codes and e-mail addresses stay out of reprs.
"""

import secrets
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

from . import repository as repo
from .ca_auth import (  # shared token, timestamp and challenge helpers
    SessionInvalid,
    VerificationFailed,
    _now,
    _parse,
    _redeem_challenge,
    _stamp,
    _token_hash,
    _valid_token,
)
from .ids import normalise_email
from .repository import FirmScope, NotFound

CLIENT_CHALLENGE_TTL = timedelta(minutes=30)
CLIENT_CHALLENGE_ATTEMPTS = 5
CLIENT_SESSION_IDLE = timedelta(minutes=30)
CLIENT_SESSION_ABSOLUTE = timedelta(hours=12)
FINANCIAL_YEARS_OFFERED = 3


@dataclass(frozen=True)
class ClientStart:
    """Result of a start request. Callers must answer identically whether or
    not `token` is set. `token` goes into the e-mail only."""

    email: str | None
    firm_id: str | None
    token: str | None

    @property
    def should_send(self) -> bool:
        return self.token is not None

    def __repr__(self) -> str:
        return f"ClientStart(should_send={self.should_send})"


@dataclass(frozen=True)
class ClientPrincipal:
    client_identity_id: str
    firm_id: str
    firm_code_id: str | None
    email: str
    idle_expires_at: str
    absolute_expires_at: str

    @property
    def scope(self) -> FirmScope:
        return FirmScope(self.firm_id)

    def __repr__(self) -> str:
        return "ClientPrincipal(<redacted>)"


@dataclass(frozen=True)
class ClientLogin:
    token: str  # for the cookie only; never store or log it
    principal: ClientPrincipal

    def __repr__(self) -> str:
        return "ClientLogin(token=<redacted>)"


class OnboardingClosed(Exception):
    """The firm code behind this session can no longer be used to open cases."""


# --- start and verify ---------------------------------------------------------------------------


def start_client_onboarding(conn, firm_code: object, email: object, *, now: datetime | None = None) -> ClientStart:
    """Issue a sign-in challenge for a valid firm code and e-mail; otherwise
    return an empty result (never an error that reveals which part failed)."""
    moment = _now(now)
    try:
        email_norm = normalise_email(email)
        firm = repo.find_active_firm_by_code(conn, firm_code if isinstance(firm_code, str) else "")
    except (ValueError, NotFound):
        return ClientStart(None, None, None)
    secret = secrets.token_urlsafe(32)
    with repo._atomic(conn):
        repo.supersede_client_challenges(conn, firm_id=firm["firm_id"], subject=email_norm, now=_stamp(moment))
        challenge = repo.create_challenge(
            conn, purpose="client_login", subject=email_norm, secret_hash=_token_hash(secret),
            max_attempts=CLIENT_CHALLENGE_ATTEMPTS, expires_at=_stamp(moment + CLIENT_CHALLENGE_TTL),
            firm_id=firm["firm_id"], firm_code_id=firm["firm_code_id"],
        )
    return ClientStart(email_norm, firm["firm_id"], f"{challenge['id']}.{secret}")


def verify_client(conn, token: object, *, now: datetime | None = None) -> ClientLogin:
    """Redeem a sign-in link and open a client session. Any problem (bad,
    used, expired or superseded link; code revoked; firm inactive) raises
    VerificationFailed with no further detail."""
    moment = _now(now)
    ch = _redeem_challenge(conn, token, purpose="client_login", moment=moment)
    scope = FirmScope(ch["firm_id"])
    session_token = secrets.token_urlsafe(32)
    with repo._atomic(conn):
        if not repo.consume_challenge(conn, ch["id"]):  # single use, even under a race
            raise VerificationFailed()
        if ch["firm_code_id"] is None or not repo.is_firm_code_usable(conn, scope, ch["firm_code_id"]):
            raise VerificationFailed()
        identity = repo.get_or_create_client_identity(conn, scope, ch["subject"])
        repo.mark_client_email_verified(conn, scope, identity["id"])
        repo.create_session(
            conn, kind="client", firm_id=scope.firm_id, client_identity_id=identity["id"],
            token_hash=_token_hash(session_token), firm_code_id=ch["firm_code_id"],
            idle_expires_at=_stamp(moment + CLIENT_SESSION_IDLE),
            absolute_expires_at=_stamp(moment + CLIENT_SESSION_ABSOLUTE),
        )
    return ClientLogin(session_token, authenticate_client_session(conn, session_token, now=moment))


# --- sessions ------------------------------------------------------------------------------------


def _client_session(conn, token: object) -> dict:
    if not _valid_token(token):
        raise SessionInvalid()
    try:
        session = repo.get_session_by_token_hash(conn, _token_hash(token))
    except NotFound:
        raise SessionInvalid() from None
    if session["kind"] != "client":
        raise SessionInvalid()
    return session


def authenticate_client_session(conn, token: object, *, now: datetime | None = None) -> ClientPrincipal:
    """Resolve a client token to its principal, sliding the idle timeout.
    Expired sessions and sessions whose identity or firm is no longer usable
    are revoked and raise SessionInvalid."""
    moment = _now(now)
    session = _client_session(conn, token)
    idle, absolute = _parse(session["idle_expires_at"]), _parse(session["absolute_expires_at"])
    if moment >= idle or moment >= absolute:
        repo.revoke_session(conn, session["id"])
        raise SessionInvalid()
    scope = FirmScope(session["firm_id"])
    try:
        identity = repo.get_client_identity(conn, scope, session["client_identity_id"])
        firm = repo.get_firm(conn, scope)
    except NotFound:
        repo.revoke_session(conn, session["id"])
        raise SessionInvalid() from None
    if firm["status"] != "active" or identity["email_verified_at"] is None:
        repo.revoke_session(conn, session["id"])
        raise SessionInvalid()
    new_idle = min(moment + CLIENT_SESSION_IDLE, absolute)
    repo.touch_session(conn, session["id"], idle_expires_at=_stamp(new_idle))
    return ClientPrincipal(identity["id"], scope.firm_id, session["firm_code_id"], identity["email_norm"],
                           _stamp(new_idle), session["absolute_expires_at"])


def logout_client(conn, token: object) -> None:
    """Revoke the presented client session, if it is one. Never raises."""
    try:
        session = _client_session(conn, token)
    except SessionInvalid:
        return
    repo.revoke_session(conn, session["id"])


# --- cases ----------------------------------------------------------------------------------------


def financial_year_options(today: date | None = None) -> list[str]:
    """The financial years a client may open a case for, newest first: the
    current Indian financial year (April-March) and the two before it."""
    today = today or datetime.now(UTC).date()
    start = today.year if today.month >= 4 else today.year - 1
    return [f"{y}-{(y + 1) % 100:02d}" for y in range(start, start - FINANCIAL_YEARS_OFFERED, -1)]


def can_open_cases(conn, principal: ClientPrincipal) -> bool:
    return principal.firm_code_id is not None and repo.is_firm_code_usable(conn, principal.scope,
                                                                          principal.firm_code_id)


def open_case(conn, principal: ClientPrincipal, *, first_name: str, financial_year: str,
              today: date | None = None) -> tuple[dict, bool]:
    """Open the client's case for a financial year, or return the open one
    that already exists (repeats and retries never create a second case; only
    a closed case frees the slot). Returns (case, created).

    Raises repo.InvalidInput for a year that is not offered or a bad name, and
    OnboardingClosed if the session's firm code is no longer usable."""
    if financial_year not in financial_year_options(today):
        raise repo.InvalidInput("financial_year")
    scope = principal.scope
    for _ in range(2):
        try:
            return repo.find_open_case(conn, scope, principal.client_identity_id, financial_year), False
        except NotFound:
            pass
        if not can_open_cases(conn, principal):
            raise OnboardingClosed()
        try:
            with repo._atomic(conn):
                case = repo.create_case(conn, scope, client_identity_id=principal.client_identity_id,
                                        first_name=first_name, financial_year=financial_year,
                                        firm_code_id=principal.firm_code_id)
                repo.record_audit_event(conn, actor_kind="client", actor_id=principal.client_identity_id,
                                        firm_id=scope.firm_id, case_id=case["id"], action="case.created")
            return case, True
        except repo.Conflict as exc:
            if exc.code != "open_case_exists":  # a concurrent request opened it: return that one
                raise
    return repo.find_open_case(conn, scope, principal.client_identity_id, financial_year), False
