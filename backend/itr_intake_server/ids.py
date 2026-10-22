"""Identifiers and input normalisation for the repository layer.

- Internal IDs are UUID4 text in canonical lower-case form. `parse_id()`
  validates an ID supplied by a caller; it never generates one.
- Case references (e.g. "IT-DEVANSH-7K4P92") are for people to recognise a
  case. They are random enough to tell clients with the same first name
  apart, but they are not secrets and never authenticate anything.
"""

import re
import secrets
import unicodedata
import uuid
from decimal import Decimal, InvalidOperation

from .db import new_id

# Crockford base32 without I, L, O and U, so references are easy to read aloud.
_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
REFERENCE_SUFFIX_LENGTH = 6
_REFERENCE_NAME_MAX = 12
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_FINANCIAL_YEAR = re.compile(r"^(\d{4})-(\d{2})$")


class InvalidId(ValueError):
    """The value is not a canonical UUID4 identifier."""


def parse_id(value: object) -> str:
    """Return `value` if it is a canonical lower-case UUID4 string; otherwise
    raise InvalidId. Never creates a new ID."""
    if not isinstance(value, str) or len(value) != 36:
        raise InvalidId("invalid identifier")
    try:
        parsed = uuid.UUID(value)
    except ValueError:
        raise InvalidId("invalid identifier") from None
    if parsed.version != 4 or str(parsed) != value:
        raise InvalidId("invalid identifier")
    return value


def generate_id() -> str:
    """A new internal ID for a record being created."""
    return new_id()


def reference_name(first_name: str) -> str:
    """Upper-case ASCII letters of the first name (accents removed), at most
    12 characters; "CLIENT" if nothing usable remains."""
    ascii_text = unicodedata.normalize("NFKD", first_name).encode("ascii", "ignore").decode("ascii")
    letters = re.sub(r"[^A-Za-z]", "", ascii_text).upper()[:_REFERENCE_NAME_MAX]
    return letters or "CLIENT"


def new_case_reference(first_name: str) -> str:
    """A human-readable case reference, e.g. "IT-DEVANSH-7K4P92".
    Uniqueness is enforced by the database; callers retry on a collision."""
    suffix = "".join(secrets.choice(_REFERENCE_ALPHABET) for _ in range(REFERENCE_SUFFIX_LENGTH))
    return f"IT-{reference_name(first_name)}-{suffix}"


FIRM_CODE_LENGTH = 12  # 12 symbols from a 32-symbol alphabet: 60 random bits


def new_firm_code() -> str:
    """A new random firm code (cryptographically secure), stored without
    separators, e.g. "7K4P92XMQR3T". Uniqueness is enforced by the database;
    callers retry on a collision. A firm code identifies a firm to new clients
    and never authenticates anyone, but it is still kept out of logs."""
    return "".join(secrets.choice(_REFERENCE_ALPHABET) for _ in range(FIRM_CODE_LENGTH))


def format_firm_code(code: str) -> str:
    """Readable form in groups of four: "7K4P-92XM-QR3T"."""
    return "-".join(code[i:i + 4] for i in range(0, len(code), 4))


def normalise_email(email: object) -> str:
    """Trimmed, lower-case e-mail address; raises ValueError if malformed."""
    if not isinstance(email, str):
        raise ValueError("invalid email")
    value = email.strip().lower()
    if len(value) > 254 or not _EMAIL.match(value):
        raise ValueError("invalid email")
    return value


def validate_financial_year(value: object) -> str:
    """'YYYY-YY' where the second year follows the first (e.g. '2025-26')."""
    if not isinstance(value, str) or not (m := _FINANCIAL_YEAR.match(value)):
        raise ValueError("invalid financial year")
    if (int(m[1]) + 1) % 100 != int(m[2]):
        raise ValueError("invalid financial year")
    return value


def money_text(value: object, *, allow_negative: bool = False) -> str | None:
    """Exact decimal text for a money column. Accepts Decimal, int or decimal
    strings; rejects floats (which cannot represent money exactly)."""
    if value is None:
        return None
    if isinstance(value, float) or isinstance(value, bool):
        raise ValueError("money must be Decimal, int or decimal text, not float")
    try:
        number = Decimal(str(value).strip())
    except InvalidOperation:
        raise ValueError("invalid amount") from None
    if not number.is_finite() or (number < 0 and not allow_negative):
        raise ValueError("invalid amount")
    return format(number, "f")
