"""Firm-code management for signed-in CAs (Stage 5.5).

A firm code lets a new client find their CA firm; it never authenticates
anyone. Each firm has at most one active code (enforced by the database).

Rules
-----
- The firm comes only from the authenticated `CaPrincipal`; nothing here
  accepts a firm ID or a code ID from a caller. Session authentication already
  requires an active, e-mail-verified user of an active (approved) firm.
- Viewing is open to any such user; creating, rotating and revoking require
  the firm owner role.
- Rotation replaces the active code atomically: the old code is revoked at
  the same moment and is no longer accepted. There is no grace period; the
  schema only knows 'active' and 'revoked', and adding one would need a new
  migration and an explicit decision.
- Revocation stops new onboarding with that code immediately. Existing cases
  keep their reference to the code that created them and are unaffected.
- Codes are generated with `secrets` (`ids.new_firm_code`) and retried on the
  (very unlikely) collision. Codes never appear in logs or audit details;
  audit events carry the internal code ID only.
"""

from dataclasses import dataclass

from . import repository as repo
from .ca_auth import CaPrincipal
from .ids import format_firm_code, new_firm_code

MAX_GENERATION_ATTEMPTS = 5


class FirmCodeError(Exception):
    """A refused operation. `code` is a fixed, safe string."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class FirmCodeView:
    code: str
    display: str
    status: str
    created_at: str
    revoked_at: str | None

    @classmethod
    def from_row(cls, row: dict) -> "FirmCodeView":
        return cls(row["code"], format_firm_code(row["code"]), row["status"], row["created_at"], row["revoked_at"])

    def as_dict(self) -> dict:
        return {"code": self.code, "display": self.display, "status": self.status, "created_at": self.created_at,
                "revoked_at": self.revoked_at}


def can_manage(principal: CaPrincipal) -> bool:
    return principal.role == "owner"


def _require_manager(principal: CaPrincipal) -> None:
    if not can_manage(principal):
        raise FirmCodeError("not_permitted")


def _audit(conn, principal: CaPrincipal, action: str, code_id: str) -> None:
    repo.record_audit_event(conn, actor_kind="ca", actor_id=principal.user_id, firm_id=principal.firm_id,
                            action=action, details={"firm_code_id": code_id})


def firm_code_state(conn, principal: CaPrincipal) -> dict:
    """The active code (or None) and recent earlier codes, all revoked."""
    rows = repo.list_firm_codes(conn, principal.scope)
    active = next((r for r in rows if r["status"] == "active"), None)
    return {
        "active": FirmCodeView.from_row(active).as_dict() if active else None,
        "previous": [FirmCodeView.from_row(r).as_dict() for r in rows if r["status"] != "active"][:5],
        "can_manage": can_manage(principal),
    }


def ensure_firm_code(conn, principal: CaPrincipal) -> tuple[FirmCodeView, bool]:
    """Return the active code, creating one if the firm has none. (view, created)."""
    _require_manager(principal)
    scope = principal.scope
    for _ in range(MAX_GENERATION_ATTEMPTS):
        try:
            return FirmCodeView.from_row(repo.get_active_firm_code(conn, scope)), False
        except repo.NotFound:
            pass
        try:
            with repo._atomic(conn):
                row = repo.create_firm_code(conn, scope, new_firm_code())
                _audit(conn, principal, "firm_code.created", row["id"])
            return FirmCodeView.from_row(row), True
        except repo.Conflict as exc:
            if exc.code not in ("firm_code_taken", "active_firm_code_exists"):
                raise
            # A collision with another firm's code: try a new one. A concurrent
            # creation for this firm: the next loop returns that code.
    raise FirmCodeError("generation_failed")


def rotate_firm_code(conn, principal: CaPrincipal) -> FirmCodeView:
    """Revoke the active code and activate a new one, atomically. Works (as a
    plain creation) when the firm has no active code."""
    _require_manager(principal)
    for _ in range(MAX_GENERATION_ATTEMPTS):
        try:
            with repo._atomic(conn):
                previous = repo.list_firm_codes(conn, principal.scope, limit=1)
                row = repo.rotate_firm_code(conn, principal.scope, new_firm_code())
                had_active = bool(previous) and previous[0]["status"] == "active"
                _audit(conn, principal, "firm_code.rotated" if had_active else "firm_code.created", row["id"])
            return FirmCodeView.from_row(row)
        except repo.Conflict as exc:
            if exc.code != "firm_code_taken":
                raise
    raise FirmCodeError("generation_failed")


def revoke_active_firm_code(conn, principal: CaPrincipal) -> FirmCodeView:
    """Revoke the firm's active code. FirmCodeError('no_active_code') if none."""
    _require_manager(principal)
    with repo._atomic(conn):
        try:
            active = repo.get_active_firm_code(conn, principal.scope)
            row = repo.revoke_firm_code(conn, principal.scope, active["id"])
        except repo.NotFound:
            raise FirmCodeError("no_active_code") from None
        _audit(conn, principal, "firm_code.revoked", row["id"])
    return FirmCodeView.from_row(row)
