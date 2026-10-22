"""Run the ITR Intake API server.

    python -m itr_intake_server --dev            # local development (loopback only)
    python -m itr_intake_server                  # production settings from ITR_* variables

Development mode binds to 127.0.0.1 only and enables the in-memory e-mail
simulation at http://127.0.0.1:<port>/dev/outbox (delivered by the separate
email worker, `python -m itr_intake_server.email_worker --dev`). It refuses
any non-loopback host. Client-supplied forwarding headers are never trusted.
"""

import argparse
import ipaddress
import sys

import uvicorn

from .app import create_app
from .settings import Settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m itr_intake_server")
    parser.add_argument("--dev", action="store_true", help="local development mode (loopback only)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)

    if args.dev:
        try:
            loopback = args.host == "localhost" or ipaddress.ip_address(args.host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            print("Development mode only listens on 127.0.0.1 / localhost.", file=sys.stderr)
            return 2
        settings = Settings.from_env(environment="development",
                                     dev_outbox_url=f"http://127.0.0.1:{args.port}/dev/outbox")
    else:
        try:
            settings = Settings.from_env()
        except ValueError as exc:
            print(f"Configuration error: {exc}", file=sys.stderr)
            return 2

    # proxy_headers=False: uvicorn would otherwise trust X-Forwarded-For from loopback peers (which includes the
    # Next.js proxy) and let a caller pick its own address, defeating peer-based abuse limits and the dev-inbox check.
    uvicorn.run(create_app(settings), host=args.host, port=args.port, server_header=False, proxy_headers=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
