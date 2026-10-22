"""The e-mail worker: a separate process that delivers queued messages.

    python -m itr_intake_server.email_worker --dev            # run until Ctrl+C
    python -m itr_intake_server.email_worker --dev --once     # one pass, then exit
    python -m itr_intake_server.email_worker                  # production: send over SMTP

Development: messages land in the development inbox (`/dev/outbox`) and are
recorded as 'simulated'; no network connection is opened. Production: messages
are sent with the SMTP provider from the ITR_SMTP_* / ITR_EMAIL_FROM variables
(see smtp_sender.py) and recorded as 'sent'. Without that configuration the
worker refuses to start rather than pretend to deliver. Output carries counts
and masked addresses only, never links, message bodies or credentials.
"""

import argparse
import logging
import os
import sys
import time
from pathlib import Path

from . import email_service as emails
from .db import DEFAULT_DATABASE_PATH, connect, initialize_database
from .dev_outbox import DevOutbox
from .smtp_sender import SmtpConfig, SmtpConfigError, SmtpSender

DEFAULT_INTERVAL_SECONDS = 5.0


def run_once(database_path: Path, sender: emails.EmailSender, *, now=None) -> emails.ProcessSummary:
    conn = connect(database_path)
    try:
        return emails.process_due_emails(conn, sender, now=now)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m itr_intake_server.email_worker")
    parser.add_argument("--dev", action="store_true", help="development environment (simulated delivery only)")
    parser.add_argument("--once", action="store_true", help="process the queue once and exit")
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL_SECONDS, help="seconds between passes")
    parser.add_argument("--db", help="database path (default: ITR_DB_PATH or backend/var/itr_intake.db)")
    args = parser.parse_args(argv)

    environment = "development" if args.dev else os.environ.get("ITR_ENV", "production")
    if args.interval < 1:
        print("--interval must be at least 1 second.", file=sys.stderr)
        return 2

    path = Path(args.db or os.environ.get("ITR_DB_PATH") or DEFAULT_DATABASE_PATH)
    if environment == "development":
        sender, label, banner = (emails.SimulatedSender(DevOutbox(path), development=True), "simulated",
                                 "development: messages are simulated, nothing is sent")
    else:
        try:
            config = SmtpConfig.from_env()
        except SmtpConfigError as exc:
            print(f"Configuration error: {exc}", file=sys.stderr)
            return 2
        if config is None:
            print("No email provider is configured (set ITR_SMTP_HOST and ITR_EMAIL_FROM), and simulated "
                  "delivery is development-only. Nothing was sent. (Use --dev for local development.)",
                  file=sys.stderr)
            return 2
        sender, label, banner = SmtpSender(config), "sent", f"production: sending via {config.host}:{config.port}"

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    initialize_database(path).close()

    print(f"Email worker started ({banner}). Ctrl+C to stop.")
    try:
        while True:
            summary = run_once(path, sender)
            if summary.delivered or summary.retried or summary.dead or summary.expired:
                print(f"{label}={summary.delivered} retrying={summary.retried} dead={summary.dead} "
                      f"expired_bodies={summary.expired}")
            if args.once:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("Email worker stopped.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
