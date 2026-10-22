"""Repository layer: explicit, scoped data access over SQLite.

Scope
-----
Firm-owned data is only reachable through a `FirmScope`. Every case-scoped
query constrains both `firm_id` and the case ID, and related records
(questions, documents, requests, ...) are matched on firm, case and their own
ID together. A `FirmScope` must be built by trusted server code from the
authenticated principal (a CA session's firm, or the firm resolved from a
validated firm code during client onboarding) -- never from a firm ID sent by
a browser. A few lookups are deliberately unscoped because they happen before
a principal exists (firm-code lookup, login by e-mail, session by token hash,
verification challenges); they are named and documented as such.

Errors
------
- `NotFound`: the record does not exist *or* is outside the caller's scope.
  The two cases are indistinguishable by design, and invalid IDs are treated
  the same way.
- `Conflict(code)`: a uniqueness or state rule was violated, e.g.
  "open_case_exists", "stale_version", "question_not_pending".
- `InvalidInput(field)`: a value is malformed or breaks a schema rule.
- `NotPermitted`: an append-only or protected record was targeted.
Messages are generic and never contain SQL, raw database errors or row
contents.

Values
------
Reads return plain dicts keyed by column name. JSON columns (`*_json`) are
decoded into Python lists/dicts under the same key. Money stays decimal text.

Transactions
------------
Multi-step writes run atomically: inside `db.transaction()` when no
transaction is open, or a savepoint when the caller already holds one.
Single-statement writes are atomic on their own.
"""

import json
import re
import sqlite3
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any

from .db import transaction, utc_now
from .ids import (
    InvalidId,
    generate_id,
    money_text,
    new_case_reference,
    normalise_email,
    parse_id,
    validate_financial_year,
)

# --- errors -------------------------------------------------------------------------


class RepositoryError(Exception):
    """Base class. Messages are safe to show; they never contain row data."""


class NotFound(RepositoryError):
    def __init__(self) -> None:
        super().__init__("Not found.")


class Conflict(RepositoryError):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(f"Conflict: {code}.")


class InvalidInput(RepositoryError):
    def __init__(self, field: str) -> None:
        self.field = field
        super().__init__(f"Invalid value: {field}.")


class NotPermitted(RepositoryError):
    def __init__(self) -> None:
        super().__init__("Operation not permitted.")


# Unique-constraint failures, matched on SQLite's "table.column, ..." text, mapped
# to stable codes. Anything unmatched becomes a generic "duplicate".
_UNIQUE_CODES = (
    ("cases.firm_id, cases.client_identity_id, cases.financial_year", "open_case_exists"),
    ("cases.reference", "reference_taken"),
    ("firms.registration_number", "registration_number_taken"),
    ("ca_users.email_norm", "email_taken"),
    ("firm_codes.firm_id", "active_firm_code_exists"),
    ("firm_codes.code", "firm_code_taken"),
    ("client_identities.firm_id, client_identities.email_norm", "client_exists"),
    ("statement_rows.case_id, statement_rows.row_number", "duplicate_row_number"),
    ("questions.case_id, questions.question_id", "question_exists"),
    ("questions.case_id", "pending_question_exists"),
    ("document_requests.case_id, document_requests.key", "document_request_exists"),
    ("documents.case_id, documents.kind, documents.sha256", "duplicate_document"),
    ("email_outbox.idempotency_key", "duplicate_email"),
    ("sessions.token_hash", "duplicate_session"),
)


def _translate(exc: sqlite3.Error, field: str = "value") -> RepositoryError:
    """Map a SQLite error to a safe repository error (no raw message kept)."""
    text = str(exc)
    if isinstance(exc, sqlite3.IntegrityError):
        if "FOREIGN KEY" in text:
            return NotFound()
        if "UNIQUE" in text:
            for needle, code in _UNIQUE_CODES:
                if needle in text:
                    return Conflict(code)
            return Conflict("duplicate")
        if "append-only" in text:
            return NotPermitted()
        return InvalidInput(field)
    return RepositoryError("Database operation failed.")


@contextmanager
def _db_errors(field: str = "value") -> Iterator[None]:
    try:
        yield
    except sqlite3.Error as exc:
        raise _translate(exc, field) from None


@contextmanager
def _atomic(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """All-or-nothing block: the existing transaction helper when outermost,
    a savepoint when nested inside a caller's transaction."""
    if not conn.in_transaction:
        with transaction(conn):
            yield conn
        return
    conn.execute("SAVEPOINT repo_atomic")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK TO repo_atomic")
        conn.execute("RELEASE repo_atomic")
        raise
    conn.execute("RELEASE repo_atomic")


# --- scope and helpers -----------------------------------------------------------------


@dataclass(frozen=True)
class FirmScope:
    """The firm a trusted server-side principal may act for. Build it only
    from authenticated server state, never from request data."""

    firm_id: str

    def __post_init__(self) -> None:
        try:
            parse_id(self.firm_id)
        except InvalidId:
            raise InvalidInput("firm_id") from None


def _id(value: object) -> str:
    """A caller-supplied ID used for lookup: invalid means not found."""
    try:
        return parse_id(value)
    except InvalidId:
        raise NotFound() from None


def _row(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        raise NotFound()
    out = dict(row)
    for key, value in out.items():
        if key.endswith("_json") and isinstance(value, str):
            out[key] = json.loads(value)
    return out


def _rows(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [_row(r) for r in rows]


def _require_case(conn: sqlite3.Connection, scope: FirmScope, case_id: object) -> str:
    cid = _id(case_id)
    if conn.execute("SELECT 1 FROM cases WHERE id = ? AND firm_id = ?", (cid, scope.firm_id)).fetchone() is None:
        raise NotFound()
    return cid


def _text(value: object, field: str, *, required: bool = True, max_len: int = 10_000) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > max_len:
        raise InvalidInput(field)
    return value


def _json(value: object, field: str) -> str:
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        raise InvalidInput(field) from None


# --- firms --------------------------------------------------------------------------------


def create_firm(conn, *, name: str, contact_phone: str | None = None, contact_address: str | None = None,
                registration_number: str | None = None) -> dict:
    """Register a firm (status pending_verification). Unscoped: there is no
    principal yet. Conflict("registration_number_taken") on a duplicate."""
    fid, now = generate_id(), utc_now()
    with _db_errors("firm"):
        conn.execute(
            "INSERT INTO firms (id, name, contact_phone, contact_address, registration_number, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (fid, _text(name, "name", max_len=200), contact_phone, contact_address,
             _text(registration_number, "registration_number", required=False, max_len=64), now, now),
        )
    return _row(conn.execute("SELECT * FROM firms WHERE id = ?", (fid,)).fetchone())


def get_firm(conn, scope: FirmScope) -> dict:
    """The caller's own firm."""
    return _row(conn.execute("SELECT * FROM firms WHERE id = ?", (scope.firm_id,)).fetchone())


def admin_set_firm_status(conn, firm_id: str, status: str, *, approved_by: str | None = None) -> dict:
    """Operator-only (e.g. the approval command line): change a firm's status.
    Setting 'active' records approval time and approver."""
    fid, now = _id(firm_id), utc_now()
    with _db_errors("status"):
        cur = conn.execute(
            "UPDATE firms SET status = ?, approved_at = CASE WHEN ? = 'active' THEN COALESCE(approved_at, ?) ELSE approved_at END, "
            "approved_by = CASE WHEN ? = 'active' THEN COALESCE(?, approved_by) ELSE approved_by END, updated_at = ? "
            "WHERE id = ?",
            (status, status, now, status, approved_by, now, fid),
        )
    if cur.rowcount == 0:
        raise NotFound()
    return _row(conn.execute("SELECT * FROM firms WHERE id = ?", (fid,)).fetchone())


# --- CA users ---------------------------------------------------------------------------------


def create_ca_user(conn, *, firm_id: str, email: str, full_name: str, password_hash: str, role: str = "owner") -> dict:
    """Create a CA user for a firm (status pending). Unscoped: used during
    registration. Conflict("email_taken") if the e-mail is already used."""
    uid, now = generate_id(), utc_now()
    try:
        email_norm = normalise_email(email)
    except ValueError:
        raise InvalidInput("email") from None
    with _db_errors("ca_user"):
        conn.execute(
            "INSERT INTO ca_users (id, firm_id, email_norm, full_name, password_hash, role, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, _id(firm_id), email_norm, _text(full_name, "full_name", max_len=200),
             _text(password_hash, "password_hash", max_len=1000), role, now, now),
        )
    return _row(conn.execute("SELECT * FROM ca_users WHERE id = ?", (uid,)).fetchone())


def get_ca_user(conn, scope: FirmScope, user_id: str) -> dict:
    """A CA user of the caller's firm."""
    return _row(conn.execute("SELECT * FROM ca_users WHERE id = ? AND firm_id = ?",
                             (_id(user_id), scope.firm_id)).fetchone())


def get_ca_user_for_login(conn, email: str) -> dict:
    """Unscoped lookup by e-mail for login and password recovery. Includes the
    password hash; callers must never return it to a client."""
    try:
        email_norm = normalise_email(email)
    except ValueError:
        raise NotFound() from None
    return _row(conn.execute("SELECT * FROM ca_users WHERE email_norm = ?", (email_norm,)).fetchone())


def set_ca_user_status(conn, scope: FirmScope, user_id: str, status: str) -> dict:
    """Change a CA user's status within the caller's firm."""
    uid = _id(user_id)
    with _db_errors("status"):
        cur = conn.execute("UPDATE ca_users SET status = ?, updated_at = ? WHERE id = ? AND firm_id = ?",
                           (status, utc_now(), uid, scope.firm_id))
    if cur.rowcount == 0:
        raise NotFound()
    return get_ca_user(conn, scope, uid)


def mark_ca_user_email_verified(conn, scope: FirmScope, user_id: str) -> dict:
    uid = _id(user_id)
    now = utc_now()
    cur = conn.execute("UPDATE ca_users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? "
                       "WHERE id = ? AND firm_id = ?", (now, now, uid, scope.firm_id))
    if cur.rowcount == 0:
        raise NotFound()
    return get_ca_user(conn, scope, uid)


# --- firm codes ----------------------------------------------------------------------------------


def _clean_code(code: object) -> str:
    if not isinstance(code, str):
        raise InvalidInput("code")
    value = re.sub(r"[\s-]", "", code).upper()
    if not re.fullmatch(r"[0-9A-Z]{8,32}", value):
        raise InvalidInput("code")
    return value


def create_firm_code(conn, scope: FirmScope, code: str) -> dict:
    """Add the firm's active code. Conflict("active_firm_code_exists") if one
    is already active; Conflict("firm_code_taken") if the code is in use."""
    kid = generate_id()
    with _db_errors("code"):
        conn.execute("INSERT INTO firm_codes (id, firm_id, code, created_at) VALUES (?, ?, ?, ?)",
                     (kid, scope.firm_id, _clean_code(code), utc_now()))
    return _row(conn.execute("SELECT * FROM firm_codes WHERE id = ?", (kid,)).fetchone())


def get_active_firm_code(conn, scope: FirmScope) -> dict:
    return _row(conn.execute("SELECT * FROM firm_codes WHERE firm_id = ? AND status = 'active'",
                             (scope.firm_id,)).fetchone())


def list_firm_codes(conn, scope: FirmScope, *, limit: int = 6) -> list[dict]:
    """The caller's firm's codes, newest first (active and revoked)."""
    return _rows(conn.execute("SELECT * FROM firm_codes WHERE firm_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
                              (scope.firm_id, limit)))


def revoke_firm_code(conn, scope: FirmScope, code_id: str) -> dict:
    """Revoke one of the caller's firm codes. Existing cases are unaffected."""
    kid = _id(code_id)
    cur = conn.execute("UPDATE firm_codes SET status = 'revoked', revoked_at = ? "
                       "WHERE id = ? AND firm_id = ? AND status = 'active'", (utc_now(), kid, scope.firm_id))
    if cur.rowcount == 0:
        raise NotFound()
    return _row(conn.execute("SELECT * FROM firm_codes WHERE id = ? AND firm_id = ?", (kid, scope.firm_id)).fetchone())


def rotate_firm_code(conn, scope: FirmScope, new_code: str) -> dict:
    """Atomically revoke the active code (if any) and activate `new_code`."""
    cleaned = _clean_code(new_code)
    with _atomic(conn), _db_errors("code"):
        now = utc_now()
        conn.execute("UPDATE firm_codes SET status = 'revoked', revoked_at = ? WHERE firm_id = ? AND status = 'active'",
                     (now, scope.firm_id))
        kid = generate_id()
        conn.execute("INSERT INTO firm_codes (id, firm_id, code, created_at) VALUES (?, ?, ?, ?)",
                     (kid, scope.firm_id, cleaned, now))
    return _row(conn.execute("SELECT * FROM firm_codes WHERE id = ?", (kid,)).fetchone())


def is_firm_code_usable(conn, scope: FirmScope, code_id: str) -> bool:
    """True if this code of the caller's firm is still active and the firm is active."""
    return conn.execute(
        "SELECT 1 FROM firm_codes c JOIN firms f ON f.id = c.firm_id "
        "WHERE c.id = ? AND c.firm_id = ? AND c.status = 'active' AND f.status = 'active'",
        (_id(code_id), scope.firm_id)).fetchone() is not None


def find_active_firm_by_code(conn, code: str) -> dict:
    """Unscoped lookup for client onboarding: an active code of an active firm.
    Returns only {firm_id, firm_name, firm_code_id}. NotFound otherwise."""
    try:
        cleaned = _clean_code(code)
    except InvalidInput:
        raise NotFound() from None
    return _row(conn.execute(
        "SELECT f.id AS firm_id, f.name AS firm_name, c.id AS firm_code_id FROM firm_codes c "
        "JOIN firms f ON f.id = c.firm_id WHERE c.code = ? AND c.status = 'active' AND f.status = 'active'",
        (cleaned,),
    ).fetchone())


# --- client identities ------------------------------------------------------------------------------


def get_or_create_client_identity(conn, scope: FirmScope, email: str) -> dict:
    """The client identity for this e-mail at the caller's firm, created if
    needed. Identities are per firm, so this never reveals another firm's."""
    try:
        email_norm = normalise_email(email)
    except ValueError:
        raise InvalidInput("email") from None
    with _atomic(conn):
        conn.execute("INSERT OR IGNORE INTO client_identities (id, firm_id, email_norm, created_at) VALUES (?, ?, ?, ?)",
                     (generate_id(), scope.firm_id, email_norm, utc_now()))
        return _row(conn.execute("SELECT * FROM client_identities WHERE firm_id = ? AND email_norm = ?",
                                 (scope.firm_id, email_norm)).fetchone())


def get_client_identity(conn, scope: FirmScope, client_identity_id: str) -> dict:
    return _row(conn.execute("SELECT * FROM client_identities WHERE id = ? AND firm_id = ?",
                             (_id(client_identity_id), scope.firm_id)).fetchone())


def mark_client_email_verified(conn, scope: FirmScope, client_identity_id: str) -> dict:
    cid = _id(client_identity_id)
    cur = conn.execute("UPDATE client_identities SET email_verified_at = COALESCE(email_verified_at, ?) "
                       "WHERE id = ? AND firm_id = ?", (utc_now(), cid, scope.firm_id))
    if cur.rowcount == 0:
        raise NotFound()
    return get_client_identity(conn, scope, cid)


# --- cases ----------------------------------------------------------------------------------------------

_CASE_STATUSES = ("draft", "statement_uploaded", "processing", "questions_in_progress", "documents_pending",
                  "submitted", "ca_review_required", "review_ready", "closed")
# Columns `update_case` may change. Fixed identifiers only; values are always bound parameters.
_CASE_UPDATABLE = {"status", "profile_json", "opening_balance", "closing_balance", "period_start", "period_end",
                   "classifier_version", "stopped_reason", "questions_issued", "generation_lease_until",
                   "reviewed_upload_id", "reviewed_at"}
_REFERENCE_ATTEMPTS = 5


def create_case(conn, scope: FirmScope, *, client_identity_id: str, first_name: str, financial_year: str,
                firm_code_id: str | None = None, profile: Mapping | None = None) -> dict:
    """Open a case for a client identity of the caller's firm.

    Conflict("open_case_exists") if the client already has a non-closed case
    for that financial year. NotFound if the client identity (or firm code)
    belongs to another firm. A new reference is drawn if one collides.
    """
    client_id = _id(client_identity_id)
    code_id = _id(firm_code_id) if firm_code_id is not None else None
    try:
        fy = validate_financial_year(financial_year)
    except ValueError:
        raise InvalidInput("financial_year") from None
    name = _text(first_name, "first_name", max_len=100).strip()
    profile_json = _json(dict(profile or {}), "profile")
    for _ in range(_REFERENCE_ATTEMPTS):
        cid, now = generate_id(), utc_now()
        try:
            conn.execute(
                "INSERT INTO cases (id, firm_id, client_identity_id, reference, financial_year, client_first_name, "
                "profile_json, created_via_firm_code_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (cid, scope.firm_id, client_id, new_case_reference(name), fy, name, profile_json, code_id, now, now),
            )
        except sqlite3.Error as exc:
            err = _translate(exc, "case")
            if isinstance(err, Conflict) and err.code == "reference_taken":
                continue
            raise err from None
        return get_case(conn, scope, cid)
    raise Conflict("reference_taken")


def get_case(conn, scope: FirmScope, case_id: str) -> dict:
    """A case of the caller's firm (constrained on both firm and case ID)."""
    return _row(conn.execute("SELECT * FROM cases WHERE id = ? AND firm_id = ?",
                             (_id(case_id), scope.firm_id)).fetchone())


def get_client_case(conn, scope: FirmScope, client_identity_id: str, case_id: str) -> dict:
    """A case visible to one client: firm, case and client identity must all match."""
    return _row(conn.execute("SELECT * FROM cases WHERE id = ? AND firm_id = ? AND client_identity_id = ?",
                             (_id(case_id), scope.firm_id, _id(client_identity_id))).fetchone())


def list_cases(conn, scope: FirmScope, *, status: str | None = None) -> list[dict]:
    """The caller's firm's cases, most recently updated first."""
    if status is not None and status not in _CASE_STATUSES:
        raise InvalidInput("status")
    if status is None:
        rows = conn.execute("SELECT * FROM cases WHERE firm_id = ? ORDER BY updated_at DESC", (scope.firm_id,))
    else:
        rows = conn.execute("SELECT * FROM cases WHERE firm_id = ? AND status = ? ORDER BY updated_at DESC",
                            (scope.firm_id, status))
    return _rows(rows)


def list_cases_with_clients(conn, scope: FirmScope) -> list[dict]:
    """The caller's firm's cases with each client's e-mail, newest update first."""
    return _rows(conn.execute(
        "SELECT c.*, i.email_norm AS client_email FROM cases c JOIN client_identities i "
        "ON i.id = c.client_identity_id AND i.firm_id = c.firm_id WHERE c.firm_id = ? ORDER BY c.updated_at DESC",
        (scope.firm_id,)))


def get_firm_case_by_reference(conn, scope: FirmScope, reference: object) -> dict:
    """A case of the caller's firm, found by its reference, with the client's
    e-mail under `client_email`. Another firm's reference (or a malformed one)
    is NotFound."""
    if not isinstance(reference, str) or not re.fullmatch(r"IT-[A-Z]{1,12}-[0-9A-Z]{6}", reference):
        raise NotFound()
    return _row(conn.execute(
        "SELECT c.*, i.email_norm AS client_email FROM cases c JOIN client_identities i "
        "ON i.id = c.client_identity_id AND i.firm_id = c.firm_id WHERE c.reference = ? AND c.firm_id = ?",
        (reference, scope.firm_id)).fetchone())


def list_client_cases(conn, scope: FirmScope, client_identity_id: str) -> list[dict]:
    return _rows(conn.execute("SELECT * FROM cases WHERE firm_id = ? AND client_identity_id = ? ORDER BY created_at",
                              (scope.firm_id, _id(client_identity_id))))


def find_open_case(conn, scope: FirmScope, client_identity_id: str, financial_year: str) -> dict:
    """The client's open (non-closed) case for a financial year, if any."""
    return _row(conn.execute(
        "SELECT * FROM cases WHERE firm_id = ? AND client_identity_id = ? AND financial_year = ? AND status <> 'closed'",
        (scope.firm_id, _id(client_identity_id), financial_year),
    ).fetchone())


def update_case(conn, scope: FirmScope, case_id: str, *, expected_version: int, **changes: Any) -> dict:
    """Change allowed case fields with optimistic locking.

    `expected_version` must equal the stored version, which is then
    incremented; otherwise Conflict("stale_version"). Setting status 'closed'
    records closed_at. Allowed fields: status, profile (mapping),
    opening_balance, closing_balance, period_start, period_end,
    classifier_version, stopped_reason, questions_issued,
    generation_lease_until.
    """
    cid = _id(case_id)
    if "profile" in changes:
        changes["profile_json"] = _json(dict(changes.pop("profile")), "profile")
    unknown = set(changes) - _CASE_UPDATABLE
    if unknown or not changes:
        raise InvalidInput(sorted(unknown)[0] if unknown else "changes")
    for field in ("opening_balance", "closing_balance"):
        if field in changes:
            try:
                changes[field] = money_text(changes[field], allow_negative=True)
            except ValueError:
                raise InvalidInput(field) from None
    if "status" in changes:
        changes["closed_at"] = utc_now() if changes["status"] == "closed" else None
    changes["updated_at"] = utc_now()
    columns = sorted(changes)  # fixed identifiers from the allow-list (plus closed_at, updated_at)
    assignments = ", ".join(f"{c} = ?" for c in columns)
    with _atomic(conn), _db_errors("case"):
        current = conn.execute("SELECT version FROM cases WHERE id = ? AND firm_id = ?", (cid, scope.firm_id)).fetchone()
        if current is None:
            raise NotFound()
        if current["version"] != expected_version:
            raise Conflict("stale_version")
        conn.execute(
            f"UPDATE cases SET {assignments}, version = version + 1 WHERE id = ? AND firm_id = ? AND version = ?",
            (*[changes[c] for c in columns], cid, scope.firm_id, expected_version),
        )
    return get_case(conn, scope, cid)


# --- statement rows ----------------------------------------------------------------------------------------

_ROW_FIELDS = ("raw_date", "raw_narration", "raw_debit", "raw_credit", "raw_balance", "txn_date", "narration",
               "mode", "counterparty", "category", "confidence", "review_status", "matched_rule",
               "classification_reason", "classifier_version")


def replace_statement_rows(conn, scope: FirmScope, case_id: str, rows: Iterable[Mapping]) -> int:
    """Replace all statement rows of a case, atomically. Each row is a mapping
    with `row_number`, `is_valid`, optional raw/parsed/classified fields,
    `debit`/`credit`/`balance` (Decimal or decimal text), `issues` and `flags`
    (lists). If any row is invalid, nothing changes. Returns the row count."""
    rows = list(rows)
    with _atomic(conn):
        cid = _require_case(conn, scope, case_id)
        conn.execute("DELETE FROM statement_rows WHERE case_id = ? AND firm_id = ?", (cid, scope.firm_id))
        for r in rows:
            try:
                debit = money_text(r.get("debit"))
                credit = money_text(r.get("credit"))
                balance = money_text(r.get("balance"), allow_negative=True)
            except ValueError:
                raise InvalidInput("amount") from None
            values = [cid, scope.firm_id, r.get("row_number"), 1 if r.get("is_valid") else 0,
                      _json(list(r.get("issues", [])), "issues"), _json(list(r.get("flags", [])), "flags"),
                      debit, credit, balance, *[r.get(f) for f in _ROW_FIELDS]]
            with _db_errors("statement_row"):
                conn.execute(
                    "INSERT INTO statement_rows (case_id, firm_id, row_number, is_valid, issues_json, flags_json, "
                    f"debit, credit, balance, {', '.join(_ROW_FIELDS)}) "
                    f"VALUES ({', '.join('?' * (9 + len(_ROW_FIELDS)))})",
                    values,
                )
    return len(rows)


def list_statement_rows(conn, scope: FirmScope, case_id: str) -> list[dict]:
    cid = _require_case(conn, scope, case_id)
    return _rows(conn.execute("SELECT * FROM statement_rows WHERE case_id = ? AND firm_id = ? ORDER BY row_number",
                              (cid, scope.firm_id)))


def list_statement_row_amounts(conn, scope: FirmScope, case_id: str) -> list[dict]:
    """Only the columns the review's balance check needs (no narrations)."""
    cid = _require_case(conn, scope, case_id)
    return _rows(conn.execute("SELECT is_valid, debit, credit FROM statement_rows WHERE case_id = ? AND firm_id = ? "
                              "ORDER BY row_number", (cid, scope.firm_id)))


# --- questions ------------------------------------------------------------------------------------------------


def add_question(conn, scope: FirmScope, case_id: str, *, question_id: str, question: str, purpose: str,
                 finding_ids: Iterable[str], transaction_ids: Iterable[str],
                 presentation_fixes: Iterable[str] = ()) -> dict:
    """Record a newly issued (pending) question; `seq` is assigned in order.
    Conflict("pending_question_exists") if the case already has one."""
    with _atomic(conn), _db_errors("question"):
        cid = _require_case(conn, scope, case_id)
        seq = conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM questions WHERE case_id = ? AND firm_id = ?",
                           (cid, scope.firm_id)).fetchone()[0]
        conn.execute(
            "INSERT INTO questions (case_id, firm_id, question_id, seq, question, purpose, finding_ids_json, "
            "transaction_ids_json, presentation_fixes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cid, scope.firm_id, _text(question_id, "question_id", max_len=64), seq,
             _text(question, "question", max_len=1000), _text(purpose, "purpose", max_len=1000),
             _json(list(finding_ids), "finding_ids"), _json(list(transaction_ids), "transaction_ids"),
             _json(list(presentation_fixes), "presentation_fixes"), utc_now()),
        )
    return get_question(conn, scope, cid, question_id)


def get_question(conn, scope: FirmScope, case_id: str, question_id: str) -> dict:
    return _row(conn.execute("SELECT * FROM questions WHERE case_id = ? AND firm_id = ? AND question_id = ?",
                             (_id(case_id), scope.firm_id, question_id)).fetchone())


def get_pending_question(conn, scope: FirmScope, case_id: str) -> dict:
    return _row(conn.execute("SELECT * FROM questions WHERE case_id = ? AND firm_id = ? AND status = 'pending'",
                             (_id(case_id), scope.firm_id)).fetchone())


def list_questions(conn, scope: FirmScope, case_id: str) -> list[dict]:
    cid = _require_case(conn, scope, case_id)
    return _rows(conn.execute("SELECT * FROM questions WHERE case_id = ? AND firm_id = ? ORDER BY seq",
                              (cid, scope.firm_id)))


def _close_pending(conn, scope, case_id, question_id, sql, params) -> dict:
    cid = _id(case_id)
    with _atomic(conn), _db_errors("answer"):
        current = conn.execute("SELECT status FROM questions WHERE case_id = ? AND firm_id = ? AND question_id = ?",
                               (cid, scope.firm_id, question_id)).fetchone()
        if current is None:
            raise NotFound()
        if current["status"] != "pending":
            raise Conflict("question_not_pending")
        conn.execute(sql + " WHERE case_id = ? AND firm_id = ? AND question_id = ? AND status = 'pending'",
                     (*params, cid, scope.firm_id, question_id))
    return get_question(conn, scope, cid, question_id)


def answer_question(conn, scope: FirmScope, case_id: str, question_id: str, answer: str) -> dict:
    """Store the client's answer to the pending question (stored as given).
    Conflict("question_not_pending") if it was already answered or withdrawn."""
    return _close_pending(conn, scope, case_id, question_id,
                          "UPDATE questions SET status = 'answered', answer_text = ?, answered_at = ?",
                          (_text(answer, "answer", max_len=5000), utc_now()))


def withdraw_question(conn, scope: FirmScope, case_id: str, question_id: str) -> dict:
    """Withdraw a pending question (it stays on record and stays counted)."""
    return _close_pending(conn, scope, case_id, question_id, "UPDATE questions SET status = 'withdrawn'", ())


# --- confirmations ------------------------------------------------------------------------------------------------


def add_confirmation(conn, scope: FirmScope, case_id: str, *, finding_id: str, proposed_category: str,
                     response: str) -> dict:
    """Append a structured client confirmation (append-only; the latest per
    finding counts)."""
    with _atomic(conn), _db_errors("confirmation"):
        cid = _require_case(conn, scope, case_id)
        seq = conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM confirmations WHERE case_id = ? AND firm_id = ?",
                           (cid, scope.firm_id)).fetchone()[0]
        conn.execute("INSERT INTO confirmations (case_id, firm_id, seq, finding_id, proposed_category, response, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (cid, scope.firm_id, seq, finding_id, proposed_category, response, utc_now()))
    return _row(conn.execute("SELECT * FROM confirmations WHERE case_id = ? AND firm_id = ? AND seq = ?",
                             (cid, scope.firm_id, seq)).fetchone())


def list_confirmations(conn, scope: FirmScope, case_id: str) -> list[dict]:
    cid = _require_case(conn, scope, case_id)
    return _rows(conn.execute("SELECT * FROM confirmations WHERE case_id = ? AND firm_id = ? ORDER BY seq",
                              (cid, scope.firm_id)))


# --- document requests and documents ---------------------------------------------------------------------------------


def add_document_request(conn, scope: FirmScope, case_id: str, *, key: str, label: str, source: str = "rules",
                         description: str | None = None, required: bool = True) -> dict:
    with _atomic(conn), _db_errors("document_request"):
        cid = _require_case(conn, scope, case_id)
        rid, now = generate_id(), utc_now()
        conn.execute("INSERT INTO document_requests (id, case_id, firm_id, key, label, source, created_at, updated_at, "
                     "description, required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                     (rid, cid, scope.firm_id, key, label, source, now, now, description, 1 if required else 0))
    return get_document_request(conn, scope, cid, rid)


def list_request_documents(conn, scope: FirmScope, case_id: str, request_id: str) -> list[dict]:
    """Stored supporting documents uploaded for one request of the caller's case."""
    return _rows(conn.execute(
        "SELECT * FROM documents WHERE request_id = ? AND case_id = ? AND firm_id = ? AND kind = 'supporting' "
        "ORDER BY created_at", (_id(request_id), _id(case_id), scope.firm_id)))


def find_supporting_document_by_hash(conn, scope: FirmScope, case_id: str, sha256: str) -> dict:
    return _row(conn.execute("SELECT * FROM documents WHERE case_id = ? AND firm_id = ? AND kind = 'supporting' "
                             "AND sha256 = ?", (_id(case_id), scope.firm_id, sha256)).fetchone())


def get_document_request(conn, scope: FirmScope, case_id: str, request_id: str) -> dict:
    return _row(conn.execute("SELECT * FROM document_requests WHERE id = ? AND case_id = ? AND firm_id = ?",
                             (_id(request_id), _id(case_id), scope.firm_id)).fetchone())


def list_document_requests(conn, scope: FirmScope, case_id: str) -> list[dict]:
    cid = _require_case(conn, scope, case_id)
    return _rows(conn.execute("SELECT * FROM document_requests WHERE case_id = ? AND firm_id = ? ORDER BY created_at",
                              (cid, scope.firm_id)))


def set_document_request_status(conn, scope: FirmScope, case_id: str, request_id: str, status: str) -> dict:
    rid, cid = _id(request_id), _id(case_id)
    with _db_errors("status"):
        cur = conn.execute("UPDATE document_requests SET status = ?, updated_at = ? WHERE id = ? AND case_id = ? AND firm_id = ?",
                           (status, utc_now(), rid, cid, scope.firm_id))
    if cur.rowcount == 0:
        raise NotFound()
    return get_document_request(conn, scope, cid, rid)


_EXTENSION = re.compile(r"^[a-z0-9]{1,8}$")


def add_document(conn, scope: FirmScope, case_id: str, *, kind: str, extension: str, display_name: str,
                 content_type: str, size_bytes: int, sha256: str, uploaded_by: str,
                 request_id: str | None = None) -> dict:
    """Record a stored file. The storage key is generated here as
    "<firm_id>/<case_id>/<document_id>.<extension>"; callers never choose a
    path. A request, if given, must belong to the same firm and case."""
    if not isinstance(extension, str) or not _EXTENSION.match(extension):
        raise InvalidInput("extension")
    with _atomic(conn), _db_errors("document"):
        cid = _require_case(conn, scope, case_id)
        rid = None
        if request_id is not None:
            rid = get_document_request(conn, scope, cid, request_id)["id"]  # NotFound if another case's
        did = generate_id()
        conn.execute(
            "INSERT INTO documents (id, case_id, firm_id, request_id, kind, storage_key, display_name, content_type, "
            "size_bytes, sha256, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (did, cid, scope.firm_id, rid, kind, f"{scope.firm_id}/{cid}/{did}.{extension}",
             _text(display_name, "display_name", max_len=255), content_type, size_bytes, sha256, uploaded_by, utc_now()),
        )
    return get_document(conn, scope, cid, did)


def get_document(conn, scope: FirmScope, case_id: str, document_id: str) -> dict:
    return _row(conn.execute("SELECT * FROM documents WHERE id = ? AND case_id = ? AND firm_id = ?",
                             (_id(document_id), _id(case_id), scope.firm_id)).fetchone())


def list_documents(conn, scope: FirmScope, case_id: str, *, kind: str | None = None) -> list[dict]:
    cid = _require_case(conn, scope, case_id)
    if kind is None:
        rows = conn.execute("SELECT * FROM documents WHERE case_id = ? AND firm_id = ? ORDER BY created_at",
                            (cid, scope.firm_id))
    else:
        rows = conn.execute("SELECT * FROM documents WHERE case_id = ? AND firm_id = ? AND kind = ? ORDER BY created_at",
                            (cid, scope.firm_id, kind))
    return _rows(rows)


def set_document_status(conn, scope: FirmScope, case_id: str, document_id: str, status: str) -> dict:
    did, cid = _id(document_id), _id(case_id)
    with _db_errors("status"):
        cur = conn.execute("UPDATE documents SET status = ? WHERE id = ? AND case_id = ? AND firm_id = ?",
                           (status, did, cid, scope.firm_id))
    if cur.rowcount == 0:
        raise NotFound()
    return get_document(conn, scope, cid, did)


# --- statement uploads (Stage 5.7) -----------------------------------------------------------------------------------

_UPLOAD_JSON_LIMIT = 200  # at most this many rejected/duplicate row entries or page warnings are kept


def get_client_case_by_reference(conn, scope: FirmScope, client_identity_id: str, reference: object) -> dict:
    """A case of this client, found by its reference. Firm, client identity and
    reference must all match; anything else (including a malformed reference)
    is NotFound."""
    if not isinstance(reference, str) or not re.fullmatch(r"IT-[A-Z]{1,12}-[0-9A-Z]{6}", reference):
        raise NotFound()
    return _row(conn.execute("SELECT * FROM cases WHERE reference = ? AND firm_id = ? AND client_identity_id = ?",
                             (reference, scope.firm_id, _id(client_identity_id))).fetchone())


def create_statement_upload(conn, scope: FirmScope, case_id: str, *, file_type: str, display_name: str,
                            size_bytes: int, status: str, document_id: str | None = None,
                            error_code: str | None = None, reasons: Iterable[str] = (),
                            page_warnings: Iterable[Mapping] = (), rejected_rows: Iterable[Mapping] = (),
                            duplicate_rows: Iterable[int] = (), pages_total: int | None = None,
                            rows_extracted: int = 0, rows_rejected: int = 0, rows_duplicate: int = 0,
                            rows_summary: int = 0, period_start: str | None = None,
                            period_end: str | None = None) -> dict:
    """Record an upload attempt and its outcome. A 'rejected' upload has no
    document (its file was never stored). Lists are truncated to a fixed size."""
    uid, now = generate_id(), utc_now()
    with _atomic(conn), _db_errors("statement_upload"):
        cid = _require_case(conn, scope, case_id)
        conn.execute(
            "INSERT INTO statement_uploads (id, case_id, firm_id, document_id, file_type, display_name, size_bytes, "
            "status, reasons_json, page_warnings_json, rejected_rows_json, duplicate_rows_json, pages_total, "
            "rows_extracted, rows_rejected, rows_duplicate, rows_summary, period_start, period_end, error_code, "
            "created_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (uid, cid, scope.firm_id, _id(document_id) if document_id else None, file_type, display_name, size_bytes,
             status, _json(list(reasons), "reasons"),
             _json([dict(w) for w in page_warnings][:_UPLOAD_JSON_LIMIT], "page_warnings"),
             _json([dict(r) for r in rejected_rows][:_UPLOAD_JSON_LIMIT], "rejected_rows"),
             _json(list(duplicate_rows)[:_UPLOAD_JSON_LIMIT], "duplicate_rows"), pages_total, rows_extracted,
             rows_rejected, rows_duplicate, rows_summary, period_start, period_end, error_code, now,
             None if status == "processing" else now),
        )
    return get_statement_upload(conn, scope, cid, uid)


def get_statement_upload(conn, scope: FirmScope, case_id: str, upload_id: str) -> dict:
    return _row(conn.execute("SELECT * FROM statement_uploads WHERE id = ? AND case_id = ? AND firm_id = ?",
                             (_id(upload_id), _id(case_id), scope.firm_id)).fetchone())


def get_statement_upload_for_document(conn, scope: FirmScope, case_id: str, document_id: str) -> dict:
    return _row(conn.execute("SELECT * FROM statement_uploads WHERE document_id = ? AND case_id = ? AND firm_id = ?",
                             (_id(document_id), _id(case_id), scope.firm_id)).fetchone())


def find_bank_statement_by_hash(conn, scope: FirmScope, case_id: str, sha256: str) -> dict:
    return _row(conn.execute("SELECT * FROM documents WHERE case_id = ? AND firm_id = ? AND kind = 'bank_statement' "
                             "AND sha256 = ?", (_id(case_id), scope.firm_id, sha256)).fetchone())


def list_case_statement_uploads(conn, scope: FirmScope, case_id: str) -> list[dict]:
    cid = _require_case(conn, scope, case_id)
    return _rows(conn.execute("SELECT * FROM statement_uploads WHERE case_id = ? AND firm_id = ? "
                              "ORDER BY created_at DESC, rowid DESC", (cid, scope.firm_id)))


def count_stored_statements(conn, scope: FirmScope, case_id: str) -> int:
    return conn.execute("SELECT count(*) FROM statement_uploads WHERE case_id = ? AND firm_id = ? "
                        "AND document_id IS NOT NULL", (_id(case_id), scope.firm_id)).fetchone()[0]


def list_firm_statement_uploads(conn, scope: FirmScope, *, limit: int = 200) -> list[dict]:
    """The caller's firm's uploads with their case reference and client first
    name, newest first. Profile JSON is decoded under `profile_json`."""
    return _rows(conn.execute(
        "SELECT u.*, c.reference AS case_reference, c.client_first_name, c.financial_year, c.profile_json "
        "FROM statement_uploads u JOIN cases c ON c.id = u.case_id AND c.firm_id = u.firm_id "
        "WHERE u.firm_id = ? ORDER BY u.created_at DESC, u.rowid DESC LIMIT ?", (scope.firm_id, limit)))


# --- sessions --------------------------------------------------------------------------------------------------------


def create_session(conn, *, kind: str, firm_id: str, token_hash: str, idle_expires_at: str, absolute_expires_at: str,
                   ca_user_id: str | None = None, client_identity_id: str | None = None,
                   firm_code_id: str | None = None) -> dict:
    """Store a session (token hash only). Trusted server code only: the
    database refuses a session whose firm is not the user's firm (NotFound),
    or a firm code of another firm (InvalidInput)."""
    sid, now = generate_id(), utc_now()
    with _db_errors("session"):
        conn.execute(
            "INSERT INTO sessions (id, token_hash, kind, firm_id, ca_user_id, client_identity_id, created_at, "
            "last_seen_at, idle_expires_at, absolute_expires_at, firm_code_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sid, token_hash, kind, _id(firm_id), _id(ca_user_id) if ca_user_id else None,
             _id(client_identity_id) if client_identity_id else None, now, now, idle_expires_at, absolute_expires_at,
             _id(firm_code_id) if firm_code_id else None),
        )
    return _row(conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone())


def get_session_by_token_hash(conn, token_hash: str) -> dict:
    """Unscoped: the non-revoked session for a token hash. Expiry checks are
    the caller's job (Stage 5.3)."""
    return _row(conn.execute("SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL",
                             (token_hash,)).fetchone())


def touch_session(conn, session_id: str, *, idle_expires_at: str) -> None:
    cur = conn.execute("UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND revoked_at IS NULL",
                       (utc_now(), idle_expires_at, _id(session_id)))
    if cur.rowcount == 0:
        raise NotFound()


def revoke_session(conn, session_id: str) -> None:
    conn.execute("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?", (utc_now(), _id(session_id)))


def revoke_ca_user_sessions(conn, scope: FirmScope, user_id: str) -> int:
    """Revoke every session of a CA user in the caller's firm; returns how many."""
    cur = conn.execute("UPDATE sessions SET revoked_at = ? WHERE ca_user_id = ? AND firm_id = ? AND revoked_at IS NULL",
                       (utc_now(), _id(user_id), scope.firm_id))
    return cur.rowcount


def revoke_firm_sessions(conn, scope: FirmScope) -> int:
    """Revoke every session (CA and client) of the caller's firm; returns how many."""
    cur = conn.execute("UPDATE sessions SET revoked_at = ? WHERE firm_id = ? AND revoked_at IS NULL",
                       (utc_now(), scope.firm_id))
    return cur.rowcount


def record_ca_login_failure(conn, user_id: str, *, max_failures: int, locked_until: str,
                            now: str | None = None) -> dict:
    """Count one failed login for a CA user in a single atomic UPDATE (the
    increment is relative, so concurrent failures are never lost). When the
    count reaches `max_failures`, set `locked_until`. If `now` is given and an
    earlier lock has already expired, counting restarts at 1 instead of
    re-locking on the next failure. Unscoped by design: used before
    authentication, with the ID from `get_ca_user_for_login`."""
    uid = _id(user_id)
    expired = "(? IS NOT NULL AND locked_until IS NOT NULL AND locked_until <= ?)"
    cur = conn.execute(
        f"UPDATE ca_users SET "
        f"failed_logins = CASE WHEN {expired} THEN 1 ELSE failed_logins + 1 END, "
        f"locked_until = CASE WHEN {expired} THEN NULL "
        f"WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END, "
        f"updated_at = ? WHERE id = ?",
        (now, now, now, now, max_failures, locked_until, utc_now(), uid),
    )
    if cur.rowcount == 0:
        raise NotFound()
    return _row(conn.execute("SELECT id, failed_logins, locked_until FROM ca_users WHERE id = ?", (uid,)).fetchone())


def set_ca_user_password_hash(conn, scope: FirmScope, user_id: str, password_hash: str) -> None:
    """Replace a CA user's password hash within the caller's firm."""
    cur = conn.execute("UPDATE ca_users SET password_hash = ?, updated_at = ? WHERE id = ? AND firm_id = ?",
                       (_text(password_hash, "password_hash", max_len=1000), utc_now(), _id(user_id), scope.firm_id))
    if cur.rowcount == 0:
        raise NotFound()


def supersede_challenges(conn, *, purpose: str, ca_user_id: str, now: str) -> int:
    """End every outstanding (unconsumed, unexpired) challenge of one purpose
    for a CA user by setting its expiry to `now`. Attempts already made stay
    recorded. The schema has no 'superseded' state, so a superseded challenge
    looks expired. Returns how many were ended."""
    cur = conn.execute(
        "UPDATE verification_challenges SET expires_at = ? "
        "WHERE purpose = ? AND ca_user_id = ? AND consumed_at IS NULL AND expires_at > ?",
        (now, purpose, _id(ca_user_id), now),
    )
    return cur.rowcount


def reset_ca_login_failures(conn, user_id: str) -> None:
    """Clear the failed-login counter and lock after a successful login."""
    conn.execute("UPDATE ca_users SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?",
                 (utc_now(), _id(user_id)))


# --- verification challenges -----------------------------------------------------------------------------------------


def create_challenge(conn, *, purpose: str, subject: str, secret_hash: str, max_attempts: int, expires_at: str,
                     firm_id: str | None = None, ca_user_id: str | None = None,
                     firm_code_id: str | None = None) -> dict:
    """Store a one-time challenge (secret hash only). `firm_code_id` (client
    challenges only) must belong to `firm_id`; the database refuses otherwise."""
    chid = generate_id()
    with _db_errors("challenge"):
        conn.execute(
            "INSERT INTO verification_challenges (id, purpose, firm_id, ca_user_id, subject, secret_hash, max_attempts, "
            "expires_at, created_at, firm_code_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (chid, purpose, _id(firm_id) if firm_id else None, _id(ca_user_id) if ca_user_id else None,
             subject, secret_hash, max_attempts, expires_at, utc_now(), _id(firm_code_id) if firm_code_id else None),
        )
    return get_challenge(conn, chid)


def supersede_client_challenges(conn, *, firm_id: str, subject: str, now: str) -> int:
    """End every outstanding client sign-in challenge for one firm and subject
    (normalised e-mail) by setting its expiry to `now`. Returns how many."""
    cur = conn.execute(
        "UPDATE verification_challenges SET expires_at = ? WHERE purpose = 'client_login' AND firm_id = ? "
        "AND subject = ? AND consumed_at IS NULL AND expires_at > ?",
        (now, _id(firm_id), subject, now),
    )
    return cur.rowcount


def get_challenge(conn, challenge_id: str) -> dict:
    """Unscoped by design: challenges exist before a principal does. The
    opaque challenge ID plus the secret is what the caller must present."""
    return _row(conn.execute("SELECT * FROM verification_challenges WHERE id = ?", (_id(challenge_id),)).fetchone())


def record_challenge_attempt(conn, challenge_id: str) -> int:
    """Count one attempt if attempts remain and the challenge is unconsumed;
    returns the new attempt count. Conflict("no_attempts_left") otherwise."""
    chid = _id(challenge_id)
    with _atomic(conn):
        cur = conn.execute("UPDATE verification_challenges SET attempts = attempts + 1 "
                           "WHERE id = ? AND consumed_at IS NULL AND attempts < max_attempts", (chid,))
        row = get_challenge(conn, chid)
        if cur.rowcount == 0:
            raise Conflict("no_attempts_left")
        return row["attempts"]


def consume_challenge(conn, challenge_id: str) -> bool:
    """Mark a challenge used. True only for the first call (single use)."""
    cur = conn.execute("UPDATE verification_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
                       (utc_now(), _id(challenge_id)))
    return cur.rowcount == 1


# --- rate limits -------------------------------------------------------------------------------------------------------


def get_rate_limit_count(conn, bucket: str, window_start: str) -> int:
    """The current count of a fixed-window counter (0 if none)."""
    row = conn.execute("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?",
                       (bucket, window_start)).fetchone()
    return row[0] if row else 0


def increment_rate_limit(conn, bucket: str, window_start: str) -> int:
    """Add one to a fixed-window counter and return the new count. Buckets
    should contain hashes, never raw e-mail addresses or IPs."""
    with _atomic(conn), _db_errors("rate_limit"):
        conn.execute("INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) "
                     "ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1", (bucket, window_start))
        return conn.execute("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?",
                            (bucket, window_start)).fetchone()[0]


# --- e-mail outbox -----------------------------------------------------------------------------------------------------


def enqueue_email(conn, *, idempotency_key: str, template: str, recipient: str, subject: str,
                  body_text: str | None, firm_id: str | None = None, case_id: str | None = None,
                  sensitive: bool = False, body_expires_at: str | None = None) -> tuple[dict, bool]:
    """Queue an e-mail once per idempotency key. Returns (entry, created);
    a repeat returns the existing entry with created=False. A case, if given,
    must belong to the given firm (NotFound otherwise).

    A `sensitive` message (one-time link or code) must say when its body
    expires (`body_expires_at`); it is cleared at delivery, on failure
    to deliver, when superseded, or at that time, whichever comes first."""
    if sensitive and not body_expires_at:
        raise InvalidInput("body_expires_at")
    eid, now = generate_id(), utc_now()
    with _atomic(conn), _db_errors("email"):
        cur = conn.execute(
            "INSERT INTO email_outbox (id, idempotency_key, firm_id, case_id, template, recipient, subject, body_text, "
            "next_attempt_at, created_at, updated_at, sensitive, body_expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (idempotency_key) DO NOTHING",
            (eid, idempotency_key, _id(firm_id) if firm_id else None, _id(case_id) if case_id else None, template,
             recipient, subject, body_text, now, now, now, 1 if sensitive else 0,
             body_expires_at if sensitive else None),
        )
        row = _row(conn.execute("SELECT * FROM email_outbox WHERE idempotency_key = ?", (idempotency_key,)).fetchone())
    return row, cur.rowcount == 1


def list_due_emails(conn, now: str, *, limit: int = 50) -> list[dict]:
    """Pending or failed entries whose next attempt is due, oldest first."""
    return _rows(conn.execute(
        "SELECT * FROM email_outbox WHERE status IN ('pending', 'failed') AND next_attempt_at <= ? "
        "ORDER BY next_attempt_at LIMIT ?", (now, limit)))


def mark_email_delivered(conn, email_id: str, *, simulated: bool, provider_message_id: str | None = None,
                         clear_body: bool = False) -> dict:
    """Record delivery ('sent', or 'simulated' when no real provider is used).
    `clear_body` removes the body afterwards (e.g. for one-time codes)."""
    eid, now = _id(email_id), utc_now()
    cur = conn.execute(
        "UPDATE email_outbox SET status = ?, sent_at = ?, provider_message_id = ?, attempts = attempts + 1, "
        "body_text = CASE WHEN ? THEN NULL ELSE body_text END, next_attempt_at = NULL, updated_at = ? "
        "WHERE id = ? AND status IN ('pending', 'failed')",
        ("simulated" if simulated else "sent", now, provider_message_id, 1 if clear_body else 0, now, eid),
    )
    if cur.rowcount == 0:
        raise NotFound()
    return _row(conn.execute("SELECT * FROM email_outbox WHERE id = ?", (eid,)).fetchone())


def mark_email_failed(conn, email_id: str, *, error_code: str, next_attempt_at: str | None) -> dict:
    """Record a failed attempt. With no `next_attempt_at` the entry is 'dead'
    (and a sensitive body is cleared). `error_code` should be a short code,
    never a provider message with data."""
    eid, now = _id(email_id), utc_now()
    dead = 1 if next_attempt_at is None else 0
    cur = conn.execute(
        "UPDATE email_outbox SET status = ?, attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?, "
        "body_text = CASE WHEN ? AND sensitive = 1 THEN NULL ELSE body_text END "
        "WHERE id = ? AND status IN ('pending', 'failed')",
        ("failed" if next_attempt_at else "dead", error_code[:100], next_attempt_at, now, dead, eid),
    )
    if cur.rowcount == 0:
        raise NotFound()
    return _row(conn.execute("SELECT * FROM email_outbox WHERE id = ?", (eid,)).fetchone())


def supersede_email(conn, idempotency_key: str) -> bool:
    """Mark a not-yet-sent entry superseded (e.g. replaced by a combined
    notification). True if an entry changed."""
    cur = conn.execute("UPDATE email_outbox SET status = 'superseded', next_attempt_at = NULL, updated_at = ?, "
                       "body_text = CASE WHEN sensitive = 1 THEN NULL ELSE body_text END "
                       "WHERE idempotency_key = ? AND status IN ('pending', 'failed')", (utc_now(), idempotency_key))
    return cur.rowcount == 1


def supersede_pending_emails(conn, *, template: str, recipient: str) -> int:
    """Supersede every not-yet-delivered message of this template for this
    recipient (a new one-time link replaces the old). Sensitive bodies are
    cleared. Returns how many entries changed."""
    cur = conn.execute("UPDATE email_outbox SET status = 'superseded', next_attempt_at = NULL, updated_at = ?, "
                       "body_text = CASE WHEN sensitive = 1 THEN NULL ELSE body_text END "
                       "WHERE template = ? AND recipient = ? AND status IN ('pending', 'failed')",
                       (utc_now(), template, recipient))
    return cur.rowcount


def claim_email(conn, email_id: str, *, expected_next_attempt_at: str, lease_until: str) -> bool:
    """Take a due entry for sending: moves its next attempt to `lease_until`
    only if it still has the value the caller read, so two workers cannot
    both send it. If the worker dies, the entry becomes due again at the lease
    end. True when this caller holds the claim."""
    cur = conn.execute("UPDATE email_outbox SET next_attempt_at = ?, updated_at = ? "
                       "WHERE id = ? AND status IN ('pending', 'failed') AND next_attempt_at = ?",
                       (lease_until, utc_now(), _id(email_id), expected_next_attempt_at))
    return cur.rowcount == 1


def expire_sensitive_email_bodies(conn, now: str) -> int:
    """Clear sensitive bodies past `body_expires_at`; an undelivered entry
    becomes 'dead' with error 'body_expired'. Returns how many bodies were cleared."""
    with _atomic(conn):
        conn.execute("UPDATE email_outbox SET status = 'dead', last_error = 'body_expired', next_attempt_at = NULL, "
                     "updated_at = ? WHERE sensitive = 1 AND body_text IS NOT NULL AND body_expires_at <= ? "
                     "AND status IN ('pending', 'failed')", (utc_now(), now))
        cur = conn.execute("UPDATE email_outbox SET body_text = NULL, updated_at = ? "
                           "WHERE sensitive = 1 AND body_text IS NOT NULL AND body_expires_at <= ?", (utc_now(), now))
    return cur.rowcount


def email_status_counts(conn) -> dict[str, int]:
    """Number of outbox entries per status (no message data)."""
    return {r["status"]: r["n"] for r in conn.execute("SELECT status, count(*) AS n FROM email_outbox GROUP BY status")}


def list_problem_emails(conn, *, limit: int = 50) -> list[dict]:
    """Failed or dead entries, newest first, with metadata only (never bodies)."""
    return _rows(conn.execute(
        "SELECT id, template, recipient, status, attempts, last_error, next_attempt_at, updated_at FROM email_outbox "
        "WHERE status IN ('failed', 'dead') ORDER BY updated_at DESC LIMIT ?", (limit,)))


def expire_rate_limits(conn, before_window_start: str) -> int:
    """Delete rate-limit counters from windows that started before the given time."""
    return conn.execute("DELETE FROM rate_limits WHERE window_start < ?", (before_window_start,)).rowcount


# --- audit events --------------------------------------------------------------------------------------------------------


def record_audit_event(conn, *, actor_kind: str, action: str, firm_id: str | None = None, case_id: str | None = None,
                       actor_id: str | None = None, details: Mapping | None = None, ip_hash: str | None = None) -> dict:
    """Append an audit event. `details` must not contain personal or financial
    data. A case, if given, must belong to the given firm (NotFound otherwise)."""
    aid = generate_id()
    with _db_errors("audit_event"):
        conn.execute(
            "INSERT INTO audit_events (id, firm_id, case_id, actor_kind, actor_id, action, details_json, ip_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (aid, _id(firm_id) if firm_id else None, _id(case_id) if case_id else None, actor_kind, actor_id,
             action, _json(dict(details or {}), "details"), ip_hash, utc_now()),
        )
    return _row(conn.execute("SELECT * FROM audit_events WHERE id = ?", (aid,)).fetchone())


def list_audit_events(conn, scope: FirmScope, *, case_id: str | None = None) -> list[dict]:
    """The caller's firm's audit events, optionally for one of its cases."""
    if case_id is None:
        rows = conn.execute("SELECT * FROM audit_events WHERE firm_id = ? ORDER BY created_at", (scope.firm_id,))
    else:
        cid = _require_case(conn, scope, case_id)
        rows = conn.execute("SELECT * FROM audit_events WHERE firm_id = ? AND case_id = ? ORDER BY created_at",
                            (scope.firm_id, cid))
    return _rows(rows)
