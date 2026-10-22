"""Operator command line. There is deliberately no HTTP equivalent and no
admin password: whoever can run this has direct access to the database file.

    python -m itr_intake_server.admin list-pending
    python -m itr_intake_server.admin approve --email ca@example.test --approved-by "Your name"
    python -m itr_intake_server.admin email-status

The database is ITR_DB_PATH or backend/var/itr_intake.db. Output never
includes password hashes, tokens or secrets.
"""

import argparse
import os
import sys
from pathlib import Path

from . import ca_auth
from . import repository as repo
from .db import DEFAULT_DATABASE_PATH, initialize_database
from .email_service import mask_email


def _db_path(value: str | None) -> Path:
    return Path(value or os.environ.get("ITR_DB_PATH") or DEFAULT_DATABASE_PATH)


def list_pending(conn) -> list[dict]:
    """CA accounts awaiting approval: safe columns only."""
    rows = conn.execute(
        "SELECT u.email_norm AS email, u.full_name, u.status AS user_status, "
        "CASE WHEN u.email_verified_at IS NULL THEN 'no' ELSE 'yes' END AS email_verified, "
        "f.name AS firm_name, f.status AS firm_status "
        "FROM ca_users u JOIN firms f ON f.id = u.firm_id WHERE u.status = 'pending' ORDER BY u.created_at"
    ).fetchall()
    return [dict(r) for r in rows]


def approve(conn, email: str, approved_by: str) -> str:
    """Approve the CA account with this e-mail. Returns a short status message."""
    try:
        user = repo.get_ca_user_for_login(conn, email)
    except repo.NotFound:
        return "No CA account with that email."
    try:
        ca_auth.admin_approve_ca(conn, firm_id=user["firm_id"], user_id=user["id"], approved_by=approved_by)
    except ca_auth.ApprovalError as exc:
        return {
            "email_not_verified": "Not approved: the email address has not been verified yet.",
            "account_disabled": "Not approved: the account or firm is disabled.",
            "approver_required": "Not approved: --approved-by is required.",
        }.get(exc.code, "Not approved.")
    return "Approved. The CA can now sign in."


def email_status(conn) -> list[str]:
    """Outbox counts per status and any failed or dead messages. Metadata
    only: masked recipients, never message bodies or links."""
    counts = repo.email_status_counts(conn)
    lines = ["Email outbox: " + (", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "empty")]
    for m in repo.list_problem_emails(conn):
        lines.append(f"{m['status'].upper()}  {m['template']}  to {mask_email(m['recipient'])}  "
                     f"attempts={m['attempts']}  error={m['last_error']}  next_attempt={m['next_attempt_at'] or '-'}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m itr_intake_server.admin")
    parser.add_argument("--db", help="database path (default: ITR_DB_PATH or backend/var/itr_intake.db)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list-pending", help="list CA accounts awaiting approval")
    sub.add_parser("email-status", help="show email outbox counts and failed or dead messages")
    ap = sub.add_parser("approve", help="approve a verified CA account")
    ap.add_argument("--email", required=True)
    ap.add_argument("--approved-by", required=True, help="your name, recorded as the approver")
    args = parser.parse_args(argv)

    conn = initialize_database(_db_path(args.db))
    try:
        if args.command == "list-pending":
            rows = list_pending(conn)
            if not rows:
                print("No CA accounts are awaiting approval.")
            for r in rows:
                print(f"{r['email']}  |  {r['full_name']}  |  firm: {r['firm_name']} ({r['firm_status']})  |  "
                      f"email verified: {r['email_verified']}")
            return 0
        if args.command == "email-status":
            print("\n".join(email_status(conn)))
            return 0
        message = approve(conn, args.email, args.approved_by)
        print(message)
        return 0 if message.startswith("Approved") else 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
