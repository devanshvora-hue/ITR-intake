"""The minimum client profile needed for statement ingestion (Stage 5.7).

Stored in `cases.profile_json` (one profile per case). The fields map to the
existing contracts: `ClientProfile.name` (classifier) and
`StatementMetadata.client_name / bank_name / account_number` (workbook,
which masks the account). Only the last four digits of the account are
collected; PAN, Aadhaar, full account numbers and credentials are not.
"""

import re
import unicodedata

from . import repository as repo
from .repository import FirmScope

_NAME = re.compile(r"^[^\W\d_](?:[^\W\d_]|[ .'\-])*$", re.UNICODE)  # letters, spaces, . ' - only
_BANK = re.compile(r"^[\w][\w .,'&()/\-]*$", re.UNICODE)
_LAST4 = re.compile(r"^\d{4}$")
PROFILE_FIELDS = ("full_name", "bank_name", "account_last4")


class ProfileInvalid(Exception):
    def __init__(self, fields: list[str]) -> None:
        self.fields = fields
        super().__init__("invalid profile")


def _clean(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise TypeError
    text = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()
    return text or None


def validate_profile(values: dict, *, case_financial_year: str) -> dict:
    """Checked, normalised profile values; ProfileInvalid lists bad fields
    (never their contents)."""
    bad: list[str] = []
    out: dict[str, str | None] = {}
    for key, pattern, low, high, required in (("full_name", _NAME, 2, 100, True),
                                              ("bank_name", _BANK, 2, 80, True),
                                              ("account_last4", _LAST4, 4, 4, False)):
        try:
            text = _clean(values.get(key))
        except TypeError:
            bad.append(key)
            continue
        if text is None:
            if required:
                bad.append(key)
            out[key] = None
            continue
        if not (low <= len(text) <= high) or not pattern.match(text) or any(not ch.isprintable() for ch in text):
            bad.append(key)
            continue
        out[key] = text
    fy = values.get("financial_year")
    if fy is not None and fy != case_financial_year:
        bad.append("financial_year")
    if bad:
        raise ProfileInvalid(bad)
    return out


def profile_view(case: dict) -> dict:
    profile = case.get("profile_json") or {}
    view = {key: profile.get(key) for key in PROFILE_FIELDS}
    view["complete"] = bool(view["full_name"] and view["bank_name"])
    return view


def save_profile(conn, scope: FirmScope, case_id: str, values: dict) -> dict:
    """Merge the checked values into the case profile (optimistic locking,
    retried once on a concurrent change)."""
    for _ in range(2):
        case = repo.get_case(conn, scope, case_id)
        profile = dict(case.get("profile_json") or {})
        profile.update(values)
        try:
            return repo.update_case(conn, scope, case_id, expected_version=case["version"], profile=profile)
        except repo.Conflict as exc:
            if exc.code != "stale_version":
                raise
    raise repo.Conflict("stale_version")
