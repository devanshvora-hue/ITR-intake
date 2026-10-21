"""ITR Intake: deterministic bank-transaction validation and classification.

This package does not compute tax and does not decide whether any amount is
taxable, exempt or deductible.
"""

from .categories import CANONICAL_CATEGORIES, Category
from .classifier import classify_statement, classify_transaction
from .config import (
    DEFAULT_CONFIG,
    AnalysisConfig,
    BankAccount,
    ClientProfile,
    ClientRule,
    FamilyMember,
    KeywordRule,
)
from .models import (
    FLAG_LARGE_CREDIT,
    FLAG_RECURRING_CREDIT,
    Confidence,
    Direction,
    RawTransaction,
    ReviewStatus,
    Transaction,
    TransactionMode,
)
from .validation import (
    Reconciliation,
    ReconciliationStatus,
    Severity,
    ValidationIssue,
    ValidationReport,
    parse_amount,
    validate_statement,
)

__all__ = [
    "CANONICAL_CATEGORIES",
    "DEFAULT_CONFIG",
    "FLAG_LARGE_CREDIT",
    "FLAG_RECURRING_CREDIT",
    "AnalysisConfig",
    "BankAccount",
    "Category",
    "ClientProfile",
    "ClientRule",
    "Confidence",
    "Direction",
    "FamilyMember",
    "KeywordRule",
    "RawTransaction",
    "Reconciliation",
    "ReconciliationStatus",
    "ReviewStatus",
    "Severity",
    "Transaction",
    "TransactionMode",
    "ValidationIssue",
    "ValidationReport",
    "classify_statement",
    "classify_transaction",
    "parse_amount",
    "validate_statement",
]
