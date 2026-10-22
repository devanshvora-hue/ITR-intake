"""FastAPI application: CA registration, e-mail verification, login, logout
and the signed-in CA's own dashboard data.

Architecture: the browser talks only to the Next.js site, which forwards
`/api/*` to this server (same origin). No CORS headers are sent, so other
origins cannot read responses.

Security boundaries
-------------------
- Session tokens travel only in an HttpOnly, SameSite=Lax, Path=/ cookie
  (Secure with the __Host- prefix in production). They never appear in a
  response body.
- State-changing requests (POST, ...) must come from an allowed Origin and
  carry the `X-ITR-Request: 1` header, which cross-site forms cannot add.
- Every protected request resolves the cookie through
  `ca_auth.authenticate_ca_session`, which enforces idle and absolute expiry
  and derives the firm scope from the database. No endpoint accepts a firm ID.
- Administrator approval is not available over HTTP; see `admin.py`.
- Errors are generic JSON; validation errors never echo submitted values,
  and unexpected errors never return stack traces or database details.
- Requests never send e-mail: they queue it in the database `email_outbox`
  and a separate worker (`email_worker.py`) delivers it. The simulated inbox
  and its page exist only when the environment is "development", and the page
  only answers direct loopback requests.
- Firm-code routes act only on the signed-in CA's own firm, changes need the
  owner role, and changes are limited per firm and per connected peer.
- Password-reset routes answer identically for known and unknown accounts and
  are limited per hashed e-mail and per connected peer (never per
  client-supplied address).
"""

import hashlib
import html
import ipaddress
import logging
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from urllib.parse import unquote

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field

from . import ca_auth, case_review, client_auth, client_profile, statements
from . import document_requests as doc_requests
from . import email_service as emails
from . import firm_codes
from . import repository as repo
from .db import connect, initialize_database
from .dev_outbox import DevOutbox
from .settings import Settings

logger = logging.getLogger("itr_intake.api")

# Abuse limits (fixed one-hour windows). Counters hold hashes only.
RESET_REQUESTS_PER_EMAIL = 3
RESET_REQUESTS_PER_PEER = 60
RESET_REQUESTS_ALL = 300
RESET_ATTEMPTS_PER_PEER = 60
RESET_ATTEMPTS_ALL = 600
RESEND_VERIFICATION_PER_EMAIL = 3
FIRM_CODE_CHANGES_PER_FIRM = 10
FIRM_CODE_CHANGES_PER_PEER = 60
CASE_REVIEWS_PER_FIRM = 60  # review preparations (re-reads a stored file, may run pdftotext)
WORKBOOKS_PER_FIRM = 120
DOCUMENT_REQUESTS_PER_FIRM = 200
DOCUMENT_STATUS_CHANGES_PER_FIRM = 200
DOCUMENT_DOWNLOADS_PER_FIRM = 300
CLIENT_DOCUMENT_UPLOADS_PER_CLIENT = 30
XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
CLIENT_STARTS_PER_EMAIL = 5
CLIENT_STARTS_PER_PEER = 60
CLIENT_STARTS_ALL = 300
CLIENT_BAD_CODES_PER_PEER = 30  # invalid firm codes; past this, the peer gets no e-mails for the window
CLIENT_VERIFY_PER_PEER = 60
CLIENT_VERIFY_ALL = 600
CLIENT_CASES_PER_CLIENT = 20
CLIENT_UPLOADS_PER_CLIENT = 20
CLIENT_PROFILE_UPDATES_PER_CLIENT = 30
_HOUR = 3600

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_HEADER = "x-itr-request"
_PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip")


# --- request models (unknown fields are rejected) -------------------------------------


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_max_length=1000)


class RegisterIn(_Model):
    full_name: str = Field(min_length=1, max_length=200)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)
    firm_name: str = Field(min_length=1, max_length=200)
    contact_phone: str | None = Field(default=None, max_length=40)
    contact_address: str | None = Field(default=None, max_length=500)
    registration_number: str | None = Field(default=None, max_length=64)


class LoginIn(_Model):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)


class DocumentRequestIn(_Model):
    label: str = Field(max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    required: bool = True


class ReviewIn(_Model):
    statement_id: str = Field(max_length=36)


class TokenIn(_Model):
    token: str = Field(max_length=200)


class EmailIn(_Model):
    email: str = Field(max_length=254)


class ClientStartIn(_Model):
    firm_code: str = Field(max_length=64)
    email: str = Field(max_length=254)


class ClientCaseIn(_Model):
    first_name: str = Field(min_length=1, max_length=100)
    financial_year: str = Field(max_length=7)


class ClientProfileIn(_Model):
    full_name: str | None = Field(default=None, max_length=200)
    bank_name: str | None = Field(default=None, max_length=200)
    account_last4: str | None = Field(default=None, max_length=10)
    financial_year: str | None = Field(default=None, max_length=7)


class ResetIn(_Model):
    token: str = Field(max_length=200)
    new_password: str = Field(max_length=256)


# --- helpers ------------------------------------------------------------------------------


def _error(status: int, error: str, message: str | None = None, **extra) -> JSONResponse:
    body = {"error": error, **({"message": message} if message else {}), **extra}
    return JSONResponse(body, status_code=status)


@contextmanager
def _db(request: Request) -> Iterator[sqlite3.Connection]:
    """A connection opened and closed within one request (and one thread)."""
    conn = connect(request.app.state.settings.database_path)
    try:
        yield conn
    finally:
        conn.close()


def _clear_cookie(response, settings: Settings) -> None:
    response.delete_cookie(settings.cookie_name, path="/", secure=settings.cookie_secure, httponly=True,
                           samesite="lax")


def _principal(request: Request, conn) -> ca_auth.CaPrincipal | None:
    token = request.cookies.get(request.app.state.settings.cookie_name)
    if not token:
        return None
    try:
        return ca_auth.authenticate_ca_session(conn, token)
    except ca_auth.SessionInvalid:
        return None


def _clear_client_cookie(response, settings: Settings) -> None:
    response.delete_cookie(settings.client_cookie_name, path="/", secure=settings.cookie_secure, httponly=True,
                           samesite="lax")


def _client_principal(request: Request, conn) -> client_auth.ClientPrincipal | None:
    token = request.cookies.get(request.app.state.settings.client_cookie_name)
    if not token:
        return None
    try:
        return client_auth.authenticate_client_session(conn, token)
    except ca_auth.SessionInvalid:
        return None


def _client_unauthenticated(settings: Settings) -> JSONResponse:
    response = _error(401, "unauthenticated", "Please start again from the client page.")
    _clear_client_cookie(response, settings)
    return response


def _case_view(case: dict) -> dict:
    return {"reference": case["reference"], "financial_year": case["financial_year"], "status": case["status"],
            "created_at": case["created_at"], "updated_at": case["updated_at"]}


class _BodyTooLarge(Exception):
    pass


async def _read_body(request: Request, limit: int) -> bytes:
    """The request body, refusing anything over `limit` bytes without
    buffering more than that."""
    declared = request.headers.get("content-length")
    if declared is not None and (not declared.isdigit() or int(declared) > limit):
        raise _BodyTooLarge()
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise _BodyTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


def _unauthenticated(settings: Settings) -> JSONResponse:
    response = _error(401, "unauthenticated", "Please sign in.")
    _clear_cookie(response, settings)
    return response


def _is_loopback(host: str | None) -> bool:
    try:
        return host is not None and ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _send_verification(request: Request, conn, user_id: str, email: str) -> str:
    """Issue a verification token and queue its e-mail. Returns the delivery
    mode. The request never sends anything: in development the message waits
    in the database outbox for the separate e-mail worker (simulated delivery);
    in production no provider exists yet, so nothing is queued or sent and we
    say so."""
    settings: Settings = request.app.state.settings
    token = ca_auth.start_email_verification(conn, user_id)
    if not settings.development:
        logger.warning("verification email not queued: no email provider is configured")
        return "not_configured"
    emails.queue_ca_email(conn, template=emails.TEMPLATE_VERIFY_EMAIL, recipient=email, token=token,
                          link=f"{settings.public_base_url}/ca/verify-email#token={token}",
                          ttl=ca_auth.EMAIL_VERIFICATION_TTL)
    return settings.email_delivery


def _delivery_body(settings: Settings, delivery: str) -> dict:
    body = {"status": "verification_required", "email_delivery": delivery}
    if delivery == "simulated":
        body["dev_outbox_url"] = settings.dev_outbox_url
    return body


def _window(name: str, key: str, window_seconds: int) -> tuple[str, str]:
    """(bucket, window start) for a fixed window. The bucket holds only a hash of `key`."""
    epoch = int(datetime.now(UTC).timestamp())
    start = datetime.fromtimestamp(epoch - epoch % window_seconds, UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return f"{name}:{hashlib.sha256(key.encode()).hexdigest()[:32]}", start


def _limit_reached(conn, name: str, key: str, limit: int, window_seconds: int) -> bool:
    """True if the counter is already at `limit` in this window (does not count a hit)."""
    return repo.get_rate_limit_count(conn, *_window(name, key, window_seconds)) >= limit


def _within_limit(conn, name: str, key: str, limit: int, window_seconds: int) -> bool:
    """Count one hit in a fixed window; False once `limit` is exceeded. The
    bucket holds only a hash of `key`, never an address or e-mail."""
    epoch = int(datetime.now(UTC).timestamp())
    bucket, start = _window(name, key, window_seconds)
    count = repo.increment_rate_limit(conn, bucket, start)
    if count == 1:  # a new counter: drop windows from before the previous day
        old = datetime.fromtimestamp(epoch - 86400, UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        repo.expire_rate_limits(conn, old)
    return count <= limit


def _peer(request: Request) -> str:
    """The directly connected peer. X-Forwarded-For and similar client-supplied
    headers are deliberately never read, so a caller can not choose its own
    bucket. Behind the Next.js proxy this is the proxy's address, so the peer
    bucket is a shared ceiling for the whole site, not a per-user limit."""
    return request.client.host if request.client else "unknown"


# --- application factory ------------------------------------------------------------------------


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    initialize_database(settings.database_path).close()

    app = FastAPI(title="ITR Intake", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.dev_outbox = DevOutbox(settings.database_path) if settings.development else None
    app.state.storage = statements.Storage(settings.storage_root)
    app.state.storage.clean_staging()
    app.state.pdftotext = statements.find_pdftotext(settings.pdftotext_path)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        fields = sorted({".".join(str(p) for p in e.get("loc", ())[1:]) or "body" for e in exc.errors()})
        return _error(422, "invalid_request", "Some fields are missing or invalid.", fields=fields)

    @app.exception_handler(Exception)
    async def _unexpected_error(request: Request, exc: Exception):
        return _error(500, "internal_error", "Something went wrong.")

    @app.middleware("http")
    async def _guard(request: Request, call_next):
        path = request.url.path
        if path.startswith("/api/") and request.method not in _SAFE_METHODS:
            origin = request.headers.get("origin")
            if origin not in settings.allowed_origins or request.headers.get(CSRF_HEADER) != "1":
                return _error(403, "forbidden", "Request not allowed.")
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if path.startswith("/api/") or path.startswith("/dev/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    # --- registration and verification ------------------------------------------------

    @app.post("/api/ca/register", status_code=202)
    def register(body: RegisterIn, request: Request):
        with _db(request) as conn:
            try:
                reg = ca_auth.register_ca(conn, **body.model_dump())
            except ca_auth.RegistrationError as exc:
                if exc.code in ("email_taken", "registration_number_taken"):
                    # Same answer as a new registration: no account enumeration.
                    return JSONResponse(_delivery_body(settings, "simulated" if settings.development else "not_configured"),
                                        status_code=202)
                return _error(400, "invalid_registration", "Please check the highlighted details.", code=exc.code)
            delivery = _send_verification(request, conn, reg.user_id, reg.email)
        return JSONResponse(_delivery_body(settings, delivery), status_code=202)

    @app.post("/api/ca/verify-email")
    def verify_email(body: TokenIn, request: Request):
        with _db(request) as conn:
            try:
                ca_auth.confirm_email(conn, body.token)
            except ca_auth.VerificationFailed:
                return _error(400, "verification_failed", "This verification link is invalid or has expired.")
        return {"status": "email_verified", "next": "awaiting_approval"}

    @app.post("/api/ca/resend-verification", status_code=202)
    def resend_verification(body: EmailIn, request: Request):
        delivery = "simulated" if settings.development else "not_configured"
        with _db(request) as conn:
            # Per hashed address only (a per-peer limit would be site-wide behind the
            # Next.js proxy). Over the limit the answer is unchanged; nothing is sent.
            if not _within_limit(conn, "resend-email", body.email.strip().lower(), RESEND_VERIFICATION_PER_EMAIL,
                                 _HOUR):
                return JSONResponse(_delivery_body(settings, delivery), status_code=202)
            try:
                user = repo.get_ca_user_for_login(conn, body.email)
            except repo.NotFound:
                user = None
            if user is not None and user["status"] == "pending" and user["email_verified_at"] is None:
                delivery = _send_verification(request, conn, user["id"], user["email_norm"])
        return JSONResponse(_delivery_body(settings, delivery), status_code=202)

    # --- password reset ---------------------------------------------------------------------

    @app.post("/api/ca/request-password-reset", status_code=202)
    def request_password_reset(body: EmailIn, request: Request):
        """Always answers the same way, whether or not the account exists, the
        e-mail could be queued, or a limit was hit. Limits use a hash of the
        e-mail plus the connected peer; client-supplied IP headers are ignored."""
        answer = {"status": "reset_requested", "email_delivery": settings.email_delivery}
        if settings.development:
            answer["dev_outbox_url"] = settings.dev_outbox_url
        with _db(request) as conn:
            checks = [  # every counter advances, so no short-circuit
                _within_limit(conn, "reset-email", body.email.strip().lower(), RESET_REQUESTS_PER_EMAIL, _HOUR),
                _within_limit(conn, "reset-peer", _peer(request), RESET_REQUESTS_PER_PEER, _HOUR),
                _within_limit(conn, "reset-all", "all", RESET_REQUESTS_ALL, _HOUR),
            ]
            if all(checks) and settings.development:
                result = ca_auth.request_password_reset(conn, body.email)
                if result.should_send:
                    emails.queue_ca_email(conn, template=emails.TEMPLATE_PASSWORD_RESET, recipient=result.email,
                                          token=result.token,
                                          link=f"{settings.public_base_url}/ca/reset-password#token={result.token}",
                                          ttl=ca_auth.PASSWORD_RESET_TTL)
        return JSONResponse(answer, status_code=202)

    @app.post("/api/ca/reset-password")
    def reset_password(body: ResetIn, request: Request):
        with _db(request) as conn:
            if not all([
                _within_limit(conn, "reset-confirm-peer", _peer(request), RESET_ATTEMPTS_PER_PEER, _HOUR),
                _within_limit(conn, "reset-confirm-all", "all", RESET_ATTEMPTS_ALL, _HOUR),
            ]):
                return _error(429, "rate_limited", "Too many attempts. Please try again later.")
            try:
                ca_auth.confirm_password_reset(conn, body.token, body.new_password)
            except ca_auth.PasswordResetFailed:
                return _error(400, "reset_failed", "This reset link is invalid or has expired.")
            except ca_auth.RegistrationError as exc:  # password policy, checked before the token is touched
                return _error(400, "invalid_password", "Please choose a stronger password.", code=exc.code)
        response = JSONResponse({"status": "password_reset"})
        _clear_cookie(response, settings)  # every session of the account was revoked
        return response

    # --- login, logout, session ------------------------------------------------------------

    @app.post("/api/ca/login")
    def login(body: LoginIn, request: Request):
        previous = request.cookies.get(settings.cookie_name)
        with _db(request) as conn:
            try:
                result = ca_auth.login_ca(conn, body.email, body.password, previous_token=previous)
            except ca_auth.AuthenticationFailed as exc:
                return _error(401, "invalid_credentials", str(exc))
        response = JSONResponse({"status": "signed_in"})
        response.set_cookie(settings.cookie_name, result.token, max_age=ca_auth.CA_SESSION_COOKIE.max_age_seconds,
                            path="/", secure=settings.cookie_secure, httponly=True, samesite="lax")
        return response

    @app.post("/api/ca/logout")
    def logout(request: Request):
        token = request.cookies.get(settings.cookie_name)
        if token:
            with _db(request) as conn:
                ca_auth.logout_ca(conn, token)
        response = JSONResponse({"status": "signed_out"})
        _clear_cookie(response, settings)
        return response

    @app.get("/api/ca/me")
    def me(request: Request):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            firm = repo.get_firm(conn, principal.scope)
        return {
            "user": {"full_name": principal.full_name, "email": principal.email, "role": principal.role},
            "firm": {"name": firm["name"], "status": firm["status"]},
            "session": {"idle_expires_at": principal.idle_expires_at,
                        "absolute_expires_at": principal.absolute_expires_at},
        }

    @app.get("/api/ca/cases")
    def cases(request: Request):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            rows = repo.list_cases_with_clients(conn, principal.scope)
            return {"cases": [{"reference": c["reference"], "financial_year": c["financial_year"],
                               "status": c["status"], "updated_at": c["updated_at"], "created_at": c["created_at"],
                               "client_first_name": c["client_first_name"], "client_email": c["client_email"],
                               "profile": client_profile.profile_view(c),
                               "readiness": case_review.readiness_view(conn, principal.scope, c)}
                              for c in rows]}

    # --- CA case review (Stage 5.8) ----------------------------------------------------------
    # The case is found by reference within the signed-in CA's firm only.

    def _ca_case_detail(conn, principal, case) -> dict:
        return {
            "case": {"reference": case["reference"], "financial_year": case["financial_year"],
                     "status": case["status"], "created_at": case["created_at"], "updated_at": case["updated_at"],
                     "client_first_name": case["client_first_name"], "client_email": case["client_email"]},
            "profile": client_profile.profile_view(case),
            "statements": [statements.upload_view(u)
                           for u in repo.list_case_statement_uploads(conn, principal.scope, case["id"])],
            "review": case_review.review_view(conn, principal.scope, case),
            "document_requests": doc_requests.list_views(conn, principal.scope, case["id"], for_ca=True),
        }

    @app.post("/api/ca/cases/{reference}/document-requests", status_code=201)
    def ca_create_document_request(reference: str, body: DocumentRequestIn, request: Request):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            try:
                case = repo.get_firm_case_by_reference(conn, principal.scope, reference)
            except repo.NotFound:
                return _error(404, "not_found", "Not found.")
            if not _within_limit(conn, "document-request-firm", principal.firm_id, DOCUMENT_REQUESTS_PER_FIRM, _HOUR):
                return _error(429, "rate_limited", "Too many document requests. Please try again later.")
            try:
                created = doc_requests.create_request(conn, scope=principal.scope, case=case,
                                                      actor_id=principal.user_id, label=body.label,
                                                      description=body.description, required=body.required)
            except doc_requests.RequestInvalid as exc:
                return _error(400, "invalid_request", "Please check the highlighted details.", fields=exc.fields)
            except doc_requests.UploadRefused as exc:
                return _error(409, exc.code, "Documents cannot be requested for this case.")
            view = doc_requests.request_view(conn, principal.scope, case["id"], created, for_ca=True)
        return JSONResponse({"request": view}, status_code=201)

    def _ca_case(conn, principal, reference):
        try:
            return repo.get_firm_case_by_reference(conn, principal.scope, reference)
        except repo.NotFound:
            return None

    def _ca_request_status_change(reference: str, request_id: str, action: str, request: Request):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            case = _ca_case(conn, principal, reference)
            if case is None:
                return _error(404, "not_found", "Not found.")
            if not _within_limit(conn, "document-status-firm", principal.firm_id, DOCUMENT_STATUS_CHANGES_PER_FIRM,
                                 _HOUR):
                return _error(429, "rate_limited", "Too many changes. Please try again later.")
            try:
                updated = doc_requests.change_status(conn, scope=principal.scope, case=case, request_id=request_id,
                                                     actor_id=principal.user_id, action=action)
            except repo.NotFound:
                return _error(404, "not_found", "Not found.")
            except doc_requests.UploadRefused as exc:
                return _error(409, exc.code, "This request cannot be changed this way.")
            return {"request": doc_requests.request_view(conn, principal.scope, case["id"], updated, for_ca=True)}

    @app.post("/api/ca/cases/{reference}/document-requests/{request_id}/waive")
    def ca_waive_document_request(reference: str, request_id: str, request: Request):
        return _ca_request_status_change(reference, request_id, "waive", request)

    @app.post("/api/ca/cases/{reference}/document-requests/{request_id}/reopen")
    def ca_reopen_document_request(reference: str, request_id: str, request: Request):
        return _ca_request_status_change(reference, request_id, "reopen", request)

    @app.get("/api/ca/cases/{reference}/documents/{document_id}")
    async def ca_download_document(reference: str, document_id: str, request: Request):
        def run():
            with _db(request) as conn:
                principal = _principal(request, conn)
                if principal is None:
                    return _unauthenticated(settings)
                case = _ca_case(conn, principal, reference)
                if case is None:
                    return _error(404, "not_found", "Not found.")
                if not _within_limit(conn, "document-download-firm", principal.firm_id, DOCUMENT_DOWNLOADS_PER_FIRM,
                                     _HOUR):
                    return _error(429, "rate_limited", "Too many downloads. Please try again later.")
                try:
                    document, data = doc_requests.load_supporting_file(
                        conn, scope=principal.scope, case=case, document_id=document_id,
                        actor_id=principal.user_id, storage=request.app.state.storage)
                except repo.NotFound:
                    return _error(404, "not_found", "Not found.")
            # The stored name is server-generated (<id>.<ext>); the client's file name is never used in headers.
            filename = f"{document['id']}.{document['storage_key'].rsplit('.', 1)[-1]}"
            return Response(content=data, media_type=document["content_type"], headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
                "Content-Security-Policy": "sandbox"})

        return await run_in_threadpool(run)

    @app.get("/api/ca/cases/{reference}")
    def ca_case_detail(reference: str, request: Request):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            try:
                case = repo.get_firm_case_by_reference(conn, principal.scope, reference)
            except repo.NotFound:
                return _error(404, "not_found", "Not found.")
            return _ca_case_detail(conn, principal, case)

    @app.post("/api/ca/cases/{reference}/review")
    async def ca_prepare_review(reference: str, body: ReviewIn, request: Request):
        def run():
            with _db(request) as conn:
                principal = _principal(request, conn)
                if principal is None:
                    return _unauthenticated(settings)
                try:
                    case = repo.get_firm_case_by_reference(conn, principal.scope, reference)
                except repo.NotFound:
                    return _error(404, "not_found", "Not found.")
                if not _within_limit(conn, "case-review-firm", principal.firm_id, CASE_REVIEWS_PER_FIRM, _HOUR):
                    return _error(429, "rate_limited", "Too many review preparations. Please try again later.")
                try:
                    case_review.prepare_review(conn, scope=principal.scope, case=case, upload_id=body.statement_id,
                                               actor_id=principal.user_id, storage=request.app.state.storage,
                                               pdftotext=request.app.state.pdftotext)
                except repo.NotFound:
                    return _error(404, "not_found", "Not found.")
                except case_review.ReviewRefused as exc:
                    return _error(409, exc.code, "This statement cannot be prepared for review.")
                except repo.Conflict as exc:
                    if exc.code != "stale_version":
                        raise
                    return _error(409, "stale_version", "The case changed meanwhile. Please reload and try again.")
                except statements.ExtractorBusy:
                    response = _error(503, "busy", "The server is busy reading other statements. Please try again shortly.")
                    response.headers["Retry-After"] = "30"
                    return response
                case = repo.get_firm_case_by_reference(conn, principal.scope, reference)
                return _ca_case_detail(conn, principal, case)

        return await run_in_threadpool(run)

    @app.get("/api/ca/cases/{reference}/workbook")
    async def ca_case_workbook(reference: str, request: Request):
        def run():
            with _db(request) as conn:
                principal = _principal(request, conn)
                if principal is None:
                    return _unauthenticated(settings)
                try:
                    case = repo.get_firm_case_by_reference(conn, principal.scope, reference)
                except repo.NotFound:
                    return _error(404, "not_found", "Not found.")
                if not _within_limit(conn, "workbook-firm", principal.firm_id, WORKBOOKS_PER_FIRM, _HOUR):
                    return _error(429, "rate_limited", "Too many workbook downloads. Please try again later.")
                try:
                    data = case_review.build_case_workbook(conn, principal.scope, case)
                except case_review.NoReview:
                    return _error(404, "no_review", "This case has no prepared review yet.")
                except Exception as exc:  # never echo row data or paths
                    logger.error("workbook generation failed error=%s", type(exc).__name__)
                    return _error(500, "workbook_failed", "The workbook could not be generated.")
                repo.record_audit_event(conn, actor_kind="ca", actor_id=principal.user_id, firm_id=principal.firm_id,
                                        case_id=case["id"], action="case.workbook_downloaded")
            # The reference is validated (IT-<LETTERS>-<6 chars>), so it is safe in a filename.
            return Response(content=data, media_type=XLSX_MEDIA_TYPE, headers={
                "Content-Disposition": f'attachment; filename="{case["reference"]}-internal-workbook.xlsx"',
                "Cache-Control": "no-store"})

        return await run_in_threadpool(run)

    @app.get("/api/ca/statements")
    def ca_statements(request: Request):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            rows = repo.list_firm_statement_uploads(conn, principal.scope)
        return {"statements": [{**statements.upload_view(u), "case_reference": u["case_reference"],
                                "client_first_name": u["client_first_name"], "financial_year": u["financial_year"],
                                "bank_name": (u["profile_json"] or {}).get("bank_name")} for u in rows]}

    # --- firm code ------------------------------------------------------------------------
    # The firm is always the signed-in CA's own; no route accepts a firm or code ID.

    def _firm_code_change(request: Request, action):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            if not firm_codes.can_manage(principal):
                return _error(403, "not_permitted", "Only the firm owner can change the firm code.")
            if not all([  # every counter advances, so no short-circuit
                _within_limit(conn, "firm-code-firm", principal.firm_id, FIRM_CODE_CHANGES_PER_FIRM, _HOUR),
                _within_limit(conn, "firm-code-peer", _peer(request), FIRM_CODE_CHANGES_PER_PEER, _HOUR),
            ]):
                return _error(429, "rate_limited", "Too many firm code changes. Please try again later.")
            try:
                return action(conn, principal)
            except firm_codes.FirmCodeError as exc:
                if exc.code == "no_active_code":
                    return _error(409, "no_active_code", "Your firm has no active code.")
                return _error(503, "unavailable", "A firm code could not be created. Please try again.")

    @app.get("/api/ca/firm-code")
    def get_firm_code(request: Request):
        with _db(request) as conn:
            principal = _principal(request, conn)
            if principal is None:
                return _unauthenticated(settings)
            return firm_codes.firm_code_state(conn, principal)

    @app.post("/api/ca/firm-code")
    def create_firm_code(request: Request):
        def action(conn, principal):
            view, created = firm_codes.ensure_firm_code(conn, principal)
            return JSONResponse({"firm_code": view.as_dict(), "created": created}, status_code=201 if created else 200)
        return _firm_code_change(request, action)

    @app.post("/api/ca/firm-code/rotate")
    def rotate_firm_code(request: Request):
        return _firm_code_change(request, lambda conn, principal: JSONResponse(
            {"firm_code": firm_codes.rotate_firm_code(conn, principal).as_dict()}))

    @app.post("/api/ca/firm-code/revoke")
    def revoke_firm_code(request: Request):
        return _firm_code_change(request, lambda conn, principal: JSONResponse(
            {"revoked": firm_codes.revoke_active_firm_code(conn, principal).as_dict()}))

    # --- client onboarding -----------------------------------------------------------------
    # Client identity, firm and firm code come only from the client session cookie.

    @app.post("/api/client/start", status_code=202)
    def client_start(body: ClientStartIn, request: Request):
        """Always the same answer, whether or not the firm code is valid, the
        e-mail could be queued, or a limit was hit."""
        answer = {"status": "check_email", "email_delivery": settings.email_delivery}
        if settings.development:
            answer["dev_outbox_url"] = settings.dev_outbox_url
        peer = _peer(request)
        with _db(request) as conn:
            checks = [  # every counter advances, so no short-circuit
                _within_limit(conn, "client-start-email", body.email.strip().lower(), CLIENT_STARTS_PER_EMAIL, _HOUR),
                _within_limit(conn, "client-start-peer", peer, CLIENT_STARTS_PER_PEER, _HOUR),
                _within_limit(conn, "client-start-all", "all", CLIENT_STARTS_ALL, _HOUR),
            ]
            guessing = _limit_reached(conn, "client-bad-code-peer", peer, CLIENT_BAD_CODES_PER_PEER, _HOUR)
            if all(checks) and not guessing and settings.development:
                result = client_auth.start_client_onboarding(conn, body.firm_code, body.email)
                if result.should_send:
                    emails.queue_ca_email(conn, template=emails.TEMPLATE_CLIENT_SIGN_IN, recipient=result.email,
                                          token=result.token, firm_id=result.firm_id,
                                          link=f"{settings.public_base_url}/client/verify#token={result.token}",
                                          ttl=client_auth.CLIENT_CHALLENGE_TTL)
                else:
                    _within_limit(conn, "client-bad-code-peer", peer, CLIENT_BAD_CODES_PER_PEER, _HOUR)
        return JSONResponse(answer, status_code=202)

    @app.post("/api/client/verify")
    def client_verify(body: TokenIn, request: Request):
        with _db(request) as conn:
            if not all([
                _within_limit(conn, "client-verify-peer", _peer(request), CLIENT_VERIFY_PER_PEER, _HOUR),
                _within_limit(conn, "client-verify-all", "all", CLIENT_VERIFY_ALL, _HOUR),
            ]):
                return _error(429, "rate_limited", "Too many attempts. Please try again later.")
            previous = request.cookies.get(settings.client_cookie_name)
            try:
                result = client_auth.verify_client(conn, body.token)
            except ca_auth.VerificationFailed:
                return _error(400, "verification_failed", "This link is invalid or has expired. Please start again.")
            if previous:
                client_auth.logout_client(conn, previous)  # rotation: a presented older session ends
        response = JSONResponse({"status": "signed_in"})
        response.set_cookie(settings.client_cookie_name, result.token,
                            max_age=int(client_auth.CLIENT_SESSION_ABSOLUTE.total_seconds()),
                            path="/", secure=settings.cookie_secure, httponly=True, samesite="lax")
        return response

    @app.get("/api/client/me")
    def client_me(request: Request):
        with _db(request) as conn:
            principal = _client_principal(request, conn)
            if principal is None:
                return _client_unauthenticated(settings)
            firm = repo.get_firm(conn, principal.scope)
            cases = repo.list_client_cases(conn, principal.scope, principal.client_identity_id)
            return {
                "client": {"email": principal.email},
                "firm": {"name": firm["name"]},
                "cases": [{**_case_view(c), "profile": client_profile.profile_view(c),
                           "statements": [statements.upload_view(u)
                                          for u in repo.list_case_statement_uploads(conn, principal.scope, c["id"])],
                           "document_requests": doc_requests.list_views(conn, principal.scope, c["id"], for_ca=False)}
                          for c in cases],
                "upload_limits": {"pdf_bytes": statements.MAX_PDF_BYTES, "csv_bytes": statements.MAX_CSV_BYTES,
                                  "statements_per_case": statements.MAX_STORED_STATEMENTS_PER_CASE,
                                  "pdf_pages": statements.MAX_PDF_PAGES},
                "financial_years": client_auth.financial_year_options(),
                "can_open_case": client_auth.can_open_cases(conn, principal),
                "session": {"idle_expires_at": principal.idle_expires_at,
                            "absolute_expires_at": principal.absolute_expires_at},
            }

    @app.post("/api/client/cases")
    def client_open_case(body: ClientCaseIn, request: Request):
        with _db(request) as conn:
            principal = _client_principal(request, conn)
            if principal is None:
                return _client_unauthenticated(settings)
            if not _within_limit(conn, "client-cases", principal.client_identity_id, CLIENT_CASES_PER_CLIENT, _HOUR):
                return _error(429, "rate_limited", "Too many attempts. Please try again later.")
            try:
                case, created = client_auth.open_case(conn, principal, first_name=body.first_name,
                                                      financial_year=body.financial_year)
            except repo.InvalidInput as exc:
                return _error(400, "invalid_request", "Please check the highlighted details.", fields=[exc.field])
            except client_auth.OnboardingClosed:
                return _error(409, "onboarding_closed",
                              "This firm code is no longer active. Please ask your CA for their current code.")
        return JSONResponse({"case": _case_view(case), "created": created}, status_code=201 if created else 200)

    def _client_case(conn, principal, reference: str) -> dict | None:
        try:
            return repo.get_client_case_by_reference(conn, principal.scope, principal.client_identity_id, reference)
        except repo.NotFound:
            return None

    @app.post("/api/client/cases/{reference}/profile")
    def client_profile_update(reference: str, body: ClientProfileIn, request: Request):
        with _db(request) as conn:
            principal = _client_principal(request, conn)
            if principal is None:
                return _client_unauthenticated(settings)
            case = _client_case(conn, principal, reference)
            if case is None:
                return _error(404, "not_found", "Not found.")
            if not _within_limit(conn, "client-profile", principal.client_identity_id,
                                 CLIENT_PROFILE_UPDATES_PER_CLIENT, _HOUR):
                return _error(429, "rate_limited", "Too many attempts. Please try again later.")
            try:
                values = client_profile.validate_profile(body.model_dump(), case_financial_year=case["financial_year"])
            except client_profile.ProfileInvalid as exc:
                return _error(400, "invalid_request", "Please check the highlighted details.", fields=exc.fields)
            updated = client_profile.save_profile(conn, principal.scope, case["id"], values)
        return {"case": _case_view(updated), "profile": client_profile.profile_view(updated)}

    @app.post("/api/client/cases/{reference}/statements")
    async def client_upload_statement(reference: str, request: Request):
        def authorise():
            with _db(request) as conn:
                principal = _client_principal(request, conn)
                if principal is None:
                    return None, None, _client_unauthenticated(settings)
                case = _client_case(conn, principal, reference)
                if case is None:
                    return None, None, _error(404, "not_found", "Not found.")
                if not client_profile.profile_view(case)["complete"]:
                    return None, None, _error(409, "profile_required",
                                              "Please complete your profile before uploading a statement.")
                if not _within_limit(conn, "client-upload", principal.client_identity_id,
                                     CLIENT_UPLOADS_PER_CLIENT, _HOUR):
                    return None, None, _error(429, "rate_limited", "Too many uploads. Please try again later.")
                return principal, case, None

        principal, case, refusal = await run_in_threadpool(authorise)
        if refusal is not None:
            return refusal
        try:
            data = await _read_body(request, statements.MAX_UPLOAD_BYTES)
        except _BodyTooLarge:
            return _error(413, "file_too_large", "The file is too large.")
        filename = unquote(request.headers.get("x-upload-filename", ""))[:255]
        content_type = request.headers.get("content-type", "")

        def process():
            with _db(request) as conn:
                return statements.handle_upload(conn, scope=principal.scope, case=case,
                                                actor_id=principal.client_identity_id, data=data, filename=filename,
                                                content_type=content_type, storage=request.app.state.storage,
                                                pdftotext=request.app.state.pdftotext)

        try:
            outcome = await run_in_threadpool(process)
        except statements.UploadRefused as exc:
            if exc.code == "busy":
                response = _error(503, "busy", "The server is busy reading other statements. Please try again shortly.")
                response.headers["Retry-After"] = "30"
                return response
            return _error(409, "upload_limit_reached", "This case already has the maximum number of statements.")
        view = statements.upload_view(outcome.upload)
        if view["status"] == "rejected":
            return JSONResponse({"statement": view, "created": outcome.created}, status_code=422)
        return JSONResponse({"statement": view, "created": outcome.created},
                            status_code=201 if outcome.created else 200)

    @app.post("/api/client/cases/{reference}/document-requests/{request_id}/files")
    async def client_upload_document(reference: str, request_id: str, request: Request):
        def authorise():
            with _db(request) as conn:
                principal = _client_principal(request, conn)
                if principal is None:
                    return None, None, _client_unauthenticated(settings)
                case = _client_case(conn, principal, reference)
                if case is None:
                    return None, None, _error(404, "not_found", "Not found.")
                try:
                    repo.get_document_request(conn, principal.scope, case["id"], request_id)
                except repo.NotFound:
                    return None, None, _error(404, "not_found", "Not found.")
                if not _within_limit(conn, "client-document-upload", principal.client_identity_id,
                                     CLIENT_DOCUMENT_UPLOADS_PER_CLIENT, _HOUR):
                    return None, None, _error(429, "rate_limited", "Too many uploads. Please try again later.")
                return principal, case, None

        principal, case, refusal = await run_in_threadpool(authorise)
        if refusal is not None:
            return refusal
        try:
            data = await _read_body(request, doc_requests.MAX_DOCUMENT_BYTES)
        except _BodyTooLarge:
            return _error(413, "file_too_large", "The file is too large.")
        filename = unquote(request.headers.get("x-upload-filename", ""))[:255]
        content_type = request.headers.get("content-type", "")

        def process():
            with _db(request) as conn:
                return doc_requests.handle_upload(conn, scope=principal.scope, case=case, request_id=request_id,
                                                  actor_id=principal.client_identity_id, data=data, filename=filename,
                                                  content_type=content_type, storage=request.app.state.storage)

        try:
            outcome = await run_in_threadpool(process)
        except repo.NotFound:
            return _error(404, "not_found", "Not found.")
        except doc_requests.UploadRefused as exc:
            status = 409 if exc.code in ("case_closed", "request_waived", "file_limit_reached",
                                         "already_uploaded_for_another_request") else 422
            return _error(status, exc.code, "This file cannot be accepted.")
        return JSONResponse({"document": doc_requests.document_view(outcome.document), "created": outcome.created},
                            status_code=201 if outcome.created else 200)

    @app.post("/api/client/logout")
    def client_logout(request: Request):
        token = request.cookies.get(settings.client_cookie_name)
        if token:
            with _db(request) as conn:
                client_auth.logout_client(conn, token)
        response = JSONResponse({"status": "signed_out"})
        _clear_client_cookie(response, settings)
        return response

    # --- development-only e-mail simulation --------------------------------------------------

    if settings.development:

        @app.get("/dev/outbox", response_class=HTMLResponse)
        def dev_outbox(request: Request):
            host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]")
            direct_loopback = (
                _is_loopback(request.client.host if request.client else None)
                and (host == "localhost" or _is_loopback(host))
                and not any(h in request.headers for h in _PROXY_HEADERS)
            )
            if not direct_loopback:
                return _error(404, "not_found")
            items = "".join(
                "<li><p><strong>To:</strong> {to}<br><strong>Subject:</strong> {subject}<br>"
                "<small>{created}</small></p><pre>{body}</pre>{link}</li>".format(
                    to=html.escape(m.to), subject=html.escape(m.subject), created=html.escape(m.created_at),
                    body=html.escape(m.body),
                    link=(f'<p><a href="{html.escape(m.link)}">Open the link in this message</a></p>' if m.link else ""),
                )
                for m in request.app.state.dev_outbox.messages()
            ) or "<li>No simulated emails yet.</li>"
            queued = request.app.state.dev_outbox.queued_count()
            waiting = (f"<p class='warn'>{queued} message(s) are waiting for the email worker. In another terminal "
                       "run <code>python -m itr_intake_server.email_worker --dev</code>, then reload this page.</p>"
                       if queued else "")
            page = (
                "<!doctype html><html lang='en'><head><meta charset='utf-8'><title>Developer outbox</title>"
                "<meta name='robots' content='noindex'>"
                "<style>body{font-family:system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;"
                "background:#faf7f1;color:#1d1b18}.warn{background:#f7ecd6;color:#8a5a10;padding:.75rem 1rem;"
                "border-radius:.5rem}li{background:#fff;border:1px solid #e4ddd0;border-radius:.75rem;"
                "padding:1rem;margin:1rem 0;list-style:none}ul{padding:0}pre{white-space:pre-wrap}</style>"
                "</head><body><h1>Developer outbox</h1>"
                "<p class='warn'><strong>Development simulation.</strong> No email was sent. These messages "
                "were placed here by the local email worker and are deleted when their link expires. "
                "This page is only available on this computer in development mode.</p>"
                f"{waiting}<ul>{items}</ul></body></html>"
            )
            return HTMLResponse(page, headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'"})

    return app
