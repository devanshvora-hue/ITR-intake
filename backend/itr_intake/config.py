"""Client profile and analysis settings.

Values marked "project setting" are not defined by the source specification;
they are explicit defaults for this prototype and can be overridden.
"""

from dataclasses import dataclass, field
from decimal import Decimal

from .categories import Category
from .models import Confidence, Direction, ReviewStatus


@dataclass(frozen=True)
class BankAccount:
    """An account the client holds. `bank_identifiers` are names or IFSC
    prefixes that may appear in narrations, e.g. ("SBI", "SBIN")."""

    bank_name: str
    account_number: str
    bank_identifiers: tuple[str, ...] = ()


@dataclass(frozen=True)
class FamilyMember:
    name: str
    relation: str
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class ClientRule:
    """A client-specific instruction, applied only after priority rules 1-4."""

    description: str
    patterns: tuple[str, ...]
    category: Category
    direction: Direction | None = None


@dataclass(frozen=True)
class ClientProfile:
    name: str
    accounts: tuple[BankAccount, ...] = ()
    upi_ids: tuple[str, ...] = ()
    mobile_numbers: tuple[str, ...] = ()
    family_members: tuple[FamilyMember, ...] = ()
    employers: tuple[str, ...] = ()
    loan_account_numbers: tuple[str, ...] = ()
    client_rules: tuple[ClientRule, ...] = ()


@dataclass(frozen=True)
class KeywordRule:
    """A narration pattern rule. Patterns are regular expressions matched
    against the normalised narration (upper case, punctuation as spaces)."""

    name: str
    category: Category
    patterns: tuple[str, ...]
    direction: Direction | None = None
    exclude: tuple[str, ...] = ()
    confidence: Confidence = Confidence.MEDIUM
    review_status: ReviewStatus = ReviewStatus.AUTO_CLASSIFIED
    note: str = ""


@dataclass(frozen=True)
class AnalysisConfig:
    # Example threshold from the source document; not a legal threshold.
    large_credit_threshold: Decimal = Decimal("50000")
    # Project setting.
    reconciliation_tolerance: Decimal = Decimal("0.01")
    # Project settings for recurring-credit detection.
    recurrence_min_occurrences: int = 3
    recurrence_amount_tolerance: Decimal = Decimal("0.10")
    recurrence_min_interval_days: int = 25
    recurrence_max_interval_days: int = 35
    # Project setting. None keeps recurring credits in "Others – Needs Review"
    # (flagged as recurring) because the source does not name a category.
    recurring_credit_category: Category | None = None
    date_formats: tuple[str, ...] = (
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%d.%m.%Y",
        "%Y-%m-%d",
        "%d-%b-%Y",
        "%d %b %Y",
        "%d/%m/%y",
    )
    # Project setting. Minimum similarity (0-1) for a name part to count as a
    # spelling variation (e.g. MEHATA for MEHTA). 0.85 keeps distinct names
    # such as MEHRA vs MEHTA (0.8) out; those are reported as weak only.
    name_similarity_threshold: float = 0.85
    bank_rules: tuple[KeywordRule, ...] = field(default=())
    source_rules: tuple[KeywordRule, ...] = field(default=())

    def __post_init__(self) -> None:
        # Imported here to avoid a circular import with rules.py.
        from .rules import DEFAULT_BANK_RULES, DEFAULT_SOURCE_RULES

        if not self.bank_rules:
            object.__setattr__(self, "bank_rules", DEFAULT_BANK_RULES)
        if not self.source_rules:
            object.__setattr__(self, "source_rules", DEFAULT_SOURCE_RULES)


DEFAULT_CONFIG = AnalysisConfig()
