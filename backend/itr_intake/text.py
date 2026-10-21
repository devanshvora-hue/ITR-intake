"""Narration helpers: normalisation, mode detection, counterparty extraction
and person-name matching. These read narrations; they never change them."""

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from enum import Enum

from .models import TransactionMode

_NON_ALNUM = re.compile(r"[^A-Z0-9@]+")
_TITLES = {"MR", "MRS", "MS", "MISS", "DR", "SHRI", "SMT", "KUM"}


def normalise(text: str) -> str:
    """Upper-case, punctuation as single spaces. '@' is kept for UPI IDs."""
    return _NON_ALNUM.sub(" ", text.upper()).strip()


def tokens(text: str) -> list[str]:
    return [t for t in normalise(text).replace("@", " ").split() if t]


def digits_only(text: str) -> str:
    return re.sub(r"\D", "", text)


_MODE_PATTERNS: tuple[tuple[str, TransactionMode], ...] = (
    (r"\bUPI\b", TransactionMode.UPI),
    (r"\bNEFT\b", TransactionMode.NEFT),
    (r"\bRTGS\b", TransactionMode.RTGS),
    (r"\bIMPS\b", TransactionMode.IMPS),
    (r"\b(N?ACH|ECS)\b", TransactionMode.ACH_NACH),
    (r"\b(ATM|ATW|NWD)\b", TransactionMode.ATM),
    (r"\b(CHQ|CHEQUE|CLG)\b", TransactionMode.CHEQUE),
    (r"\bCASH\b", TransactionMode.CASH),
    (r"\bPOS\b", TransactionMode.CARD),
    (r"\b(INT|INTEREST|CHRG|CHG|CHARGES|TDS|GST)\b", TransactionMode.BANK_INTERNAL),
)


def detect_mode(narration: str) -> TransactionMode:
    text = normalise(narration)
    for pattern, mode in _MODE_PATTERNS:
        if re.search(pattern, text):
            return mode
    return TransactionMode.OTHER


def extract_counterparty(narration: str) -> str | None:
    """Best-effort counterparty name from common UPI/IMPS/NEFT/RTGS layouts.
    Returns None when the layout is not recognised."""
    head = narration.strip().upper()
    if head.startswith(("UPI/", "IMPS/")):
        parts = narration.split("/")
        if len(parts) > 3 and parts[3].strip():
            return parts[3].strip()
    if head.startswith(("NEFT", "RTGS")):
        parts = narration.split("-")
        if len(parts) > 2 and parts[2].strip():
            return parts[2].strip()
    return None


class NameMatch(Enum):
    """How strongly a person's name was found in a narration."""

    EXACT = "exact"  # every part in full, adjacent and in order
    PARTIAL = "partial"  # initials, or full parts that are not adjacent / in order
    VARIANT = "variant"  # a spelling variation or a substantial truncation
    WEAK = "weak"  # only a short fragment or a loose resemblance; never enough to classify


@dataclass(frozen=True)
class NameMatchResult:
    strength: NameMatch
    details: tuple[str, ...] = ()

    def describe(self) -> str:
        return "; ".join(self.details)


# A truncated name part counts as a variant only if it keeps at least this many
# letters and this share of the full part; shorter fragments are weak.
_MIN_TRUNCATION_LEN = 4
_MIN_TRUNCATION_SHARE = 0.6
# Resemblance below the similarity threshold but at or above this is weak.
_WEAK_SIMILARITY = 0.7

_RANK = {"exact": 5, "variant": 4, "initial": 3, "weak": 2}


def _token_kind(tok: str, name_token: str, threshold: float) -> tuple[str, str] | None:
    """Classify how one narration token relates to one name part."""
    if tok == name_token:
        return "exact", ""
    if len(tok) == 1:
        return ("initial", f"'{tok}' as an initial for {name_token}") if tok == name_token[0] else None
    if len(name_token) < 4 or len(tok) < 3:
        return None
    if name_token.startswith(tok):
        if len(tok) >= _MIN_TRUNCATION_LEN and len(tok) >= _MIN_TRUNCATION_SHARE * len(name_token):
            return "variant", f"'{tok}' as a shortened form of {name_token}"
        return "weak", f"'{tok}' is only a short fragment of {name_token}"
    if tok.startswith(name_token):
        # The full name part plus extra letters (PRIYAM, PRIYANKA for PRIYA) is
        # usually a different name, not a misspelling.
        return "weak", f"'{tok}' extends {name_token} with extra letters and may be a different name"
    if len(tok) < 4:
        return None
    ratio = SequenceMatcher(None, tok, name_token).ratio()
    if ratio >= threshold:
        return "variant", f"'{tok}' as a spelling variation of {name_token}"
    if ratio >= _WEAK_SIMILARITY:
        return "weak", f"'{tok}' only resembles {name_token}"
    return None


def _best_token(name_token: str, text_tokens: list[str], used: set[int], threshold: float):
    best: tuple[int, str, str] | None = None
    for i, tok in enumerate(text_tokens):
        if i in used:
            continue
        found = _token_kind(tok, name_token, threshold)
        if found and (best is None or _RANK[found[0]] > _RANK[best[1]]):
            best = (i, *found)
            if found[0] == "exact":
                break
    return best


def match_name(name: str, narration: str, threshold: float = 0.85) -> NameMatchResult | None:
    """Look for a person's name in a narration.

    Every part of the name must be present in some form. Given names may be
    initials; the surname (last part) may not. A single-word name must appear
    exactly. The result's strength decides how far it can be relied on.
    """
    name_tokens = [t for t in tokens(name) if t not in _TITLES]
    text_tokens = tokens(narration)
    if not name_tokens:
        return None
    if len(name_tokens) == 1:
        return NameMatchResult(NameMatch.EXACT) if name_tokens[0] in text_tokens else None

    used: set[int] = set()
    positions: dict[int, int] = {}
    kinds: list[str] = []
    details: list[str] = []
    surname = len(name_tokens) - 1
    # Match the surname first so an initial cannot consume its token.
    for idx in [surname, *range(surname)]:
        found = None
        if idx != surname:
            # Prefer the token where this part would sit next to the surname
            # ("S MEHTA"), over a look-alike elsewhere (e.g. inside a UPI ID).
            expected = positions[surname] - (surname - idx)
            if 0 <= expected < len(text_tokens) and expected not in used:
                kind = _token_kind(text_tokens[expected], name_tokens[idx], threshold)
                if kind and kind[0] != "weak":
                    found = (expected, *kind)
        found = found or _best_token(name_tokens[idx], text_tokens, used, threshold)
        if found is None:
            return None
        pos, kind, detail = found
        if idx == surname and kind == "initial":
            return None
        used.add(pos)
        positions[idx] = pos
        kinds.append(kind)
        if detail:
            details.append(detail)

    ordered = [positions[i] for i in range(len(name_tokens))]
    adjacent = all(b == a + 1 for a, b in zip(ordered, ordered[1:]))
    if not adjacent:
        details.append("name parts are not adjacent or in order in the narration")

    if "weak" in kinds:
        strength = NameMatch.WEAK
    elif "variant" in kinds:
        strength = NameMatch.VARIANT
    elif "initial" in kinds or not adjacent:
        strength = NameMatch.PARTIAL
    else:
        strength = NameMatch.EXACT
    return NameMatchResult(strength, tuple(details))
