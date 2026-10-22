"""Server settings.

Two environments:
- "production" (the default): Secure `__Host-` cookies, origins must be
  configured explicitly as https, and no development features exist at all.
- "development": loopback-only local use, plain-http cookies, and an
  in-memory e-mail simulation. It is only enabled by an explicit choice
  (`python -m itr_intake_server --dev` or ITR_ENV=development).
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

from .db import DEFAULT_DATABASE_PATH

ENVIRONMENTS = ("development", "production")
_DEV_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")


@dataclass(frozen=True)
class Settings:
    environment: str = "production"
    database_path: Path = DEFAULT_DATABASE_PATH
    allowed_origins: tuple[str, ...] = field(default=())
    public_base_url: str = "http://localhost:3000"
    dev_outbox_url: str = "http://127.0.0.1:8000/dev/outbox"
    # Private file storage (uploaded statements). Defaults to "storage" next to the database.
    storage_root: Path | None = None
    # xpdf pdftotext; None means ITR_PDFTOTEXT or `pdftotext` on PATH (checked at startup).
    pdftotext_path: str | None = None

    def __post_init__(self) -> None:
        if self.environment not in ENVIRONMENTS:
            raise ValueError(f"environment must be one of {ENVIRONMENTS}")
        if self.development:
            if not self.allowed_origins:
                object.__setattr__(self, "allowed_origins", _DEV_ORIGINS)
        else:
            if not self.allowed_origins or not all(o.startswith("https://") for o in self.allowed_origins):
                raise ValueError("production requires ITR_ALLOWED_ORIGINS with https:// origins")
            if not self.public_base_url.startswith("https://"):
                raise ValueError("production requires an https:// ITR_PUBLIC_BASE_URL")
        object.__setattr__(self, "database_path", Path(self.database_path))
        object.__setattr__(self, "storage_root", Path(self.storage_root) if self.storage_root
                           else self.database_path.parent / "storage")
        object.__setattr__(self, "allowed_origins", tuple(o.rstrip("/") for o in self.allowed_origins))

    @property
    def development(self) -> bool:
        return self.environment == "development"

    @property
    def email_delivery(self) -> str:
        """'simulated' (development: queued for the simulated sender) or
        'not_configured' (production: no e-mail provider exists yet, so
        nothing is queued or sent)."""
        return "simulated" if self.development else "not_configured"

    @property
    def cookie_secure(self) -> bool:
        return not self.development

    @property
    def cookie_name(self) -> str:
        return "itr_ca_session" if self.development else "__Host-itr_ca_session"

    @property
    def client_cookie_name(self) -> str:
        return "itr_client_session" if self.development else "__Host-itr_client_session"

    @classmethod
    def from_env(cls, *, environment: str | None = None, **overrides) -> "Settings":
        origins = tuple(o.strip() for o in os.environ.get("ITR_ALLOWED_ORIGINS", "").split(",") if o.strip())
        values = dict(
            environment=environment or os.environ.get("ITR_ENV", "production"),
            database_path=Path(os.environ.get("ITR_DB_PATH", str(DEFAULT_DATABASE_PATH))),
            allowed_origins=origins,
            public_base_url=os.environ.get("ITR_PUBLIC_BASE_URL", "http://localhost:3000"),
        )
        values.update(overrides)
        return cls(**values)
