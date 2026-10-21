"""Typed transaction records.

Amounts are `Decimal` throughout. The original text of every amount and the
exact narration are kept alongside the parsed values and are never altered.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from enum import StrEnum

from .categories import Category


class Direction(StrEnum):
    CREDIT = "credit"
    DEBIT = "debit"


class TransactionMode(StrEnum):
    UPI = "UPI"
    NEFT = "NEFT"
    RTGS = "RTGS"
    IMPS = "IMPS"
    ACH_NACH = "ACH/NACH"
    ATM = "ATM"
    CHEQUE = "Cheque"
    CASH = "Cash"
    CARD = "Card"
    BANK_INTERNAL = "Bank internal"
    OTHER = "Other"


class Confidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class ReviewStatus(StrEnum):
    AUTO_CLASSIFIED = "Auto-classified"
    NEEDS_CONFIRMATION = "Needs confirmation"
    NEEDS_REVIEW = "Needs review"


# Flags attached to transactions for the CA's attention.
FLAG_LARGE_CREDIT = "large_credit"
FLAG_RECURRING_CREDIT = "recurring_credit"


@dataclass(frozen=True)
class RawTransaction:
    """A statement row as extracted, before validation. All values are text."""

    row_number: int
    date: str | None
    narration: str | None
    debit: str | None = None
    credit: str | None = None
    balance: str | None = None


@dataclass(frozen=True)
class Transaction:
    """A validated transaction plus its classification."""

    row_number: int
    date: date
    narration: str
    debit: Decimal
    credit: Decimal
    balance: Decimal | None
    raw_debit: str | None
    raw_credit: str | None
    raw_balance: str | None
    mode: TransactionMode
    counterparty: str | None
    category: Category = Category.OTHERS_NEEDS_REVIEW
    classification_reason: str = "Not yet classified."
    confidence: Confidence = Confidence.LOW
    review_status: ReviewStatus = ReviewStatus.NEEDS_REVIEW
    matched_rule: str | None = None
    flags: tuple[str, ...] = ()

    @property
    def direction(self) -> Direction:
        return Direction.CREDIT if self.credit > 0 else Direction.DEBIT

    @property
    def amount(self) -> Decimal:
        return self.credit if self.credit > 0 else self.debit
