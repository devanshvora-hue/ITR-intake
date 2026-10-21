"""Deterministic statement validation and balance reconciliation.

Nothing here adjusts an amount. Invalid rows are reported and excluded, and
a reconciliation is only reported as passed when every row is valid and the
difference is within the configured tolerance.
"""

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from enum import StrEnum

from .config import DEFAULT_CONFIG, AnalysisConfig
from .models import RawTransaction, Transaction
from .text import detect_mode, extract_counterparty


class Severity(StrEnum):
    ERROR = "error"
    WARNING = "warning"


@dataclass(frozen=True)
class ValidationIssue:
    row_number: int | None
    field: str
    code: str
    message: str
    severity: Severity = Severity.ERROR


class ReconciliationStatus(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    # Some rows were invalid, so the statement cannot be confirmed as balanced.
    INCOMPLETE = "incomplete"


@dataclass(frozen=True)
class Reconciliation:
    opening_balance: Decimal
    total_credits: Decimal
    total_debits: Decimal
    expected_closing_balance: Decimal
    stated_closing_balance: Decimal
    difference: Decimal  # stated - expected
    tolerance: Decimal
    status: ReconciliationStatus

    @property
    def passed(self) -> bool:
        return self.status is ReconciliationStatus.PASSED


@dataclass(frozen=True)
class ValidationReport:
    rows_received: int
    transactions: tuple[Transaction, ...]
    issues: tuple[ValidationIssue, ...]
    reconciliation: Reconciliation | None
    credit_count: int = 0
    debit_count: int = 0
    invalid_row_numbers: tuple[int, ...] = field(default=())

    @property
    def valid_count(self) -> int:
        return len(self.transactions)

    @property
    def invalid_count(self) -> int:
        return len(self.invalid_row_numbers)

    @property
    def errors(self) -> tuple[ValidationIssue, ...]:
        return tuple(i for i in self.issues if i.severity is Severity.ERROR)


class AmountError(ValueError):
    pass


def parse_amount(raw: str | Decimal | None, *, allow_negative: bool = False) -> Decimal:
    """Parse an amount exactly. Blank means zero. Thousands separators
    (including Indian grouping such as 1,23,456.78) are accepted."""
    if raw is None:
        return Decimal("0")
    if isinstance(raw, Decimal):
        value = raw
    else:
        text = raw.strip().replace(",", "").replace("₹", "").strip()
        if text in ("", "-"):
            return Decimal("0")
        try:
            value = Decimal(text)
        except InvalidOperation as exc:
            raise AmountError(f"not a number: {raw!r}") from exc
    if not value.is_finite():
        raise AmountError(f"not a finite number: {raw!r}")
    if value < 0 and not allow_negative:
        raise AmountError(f"negative amount: {raw!r}")
    return value


def parse_date(raw: str, formats: tuple[str, ...]) -> date:
    text = raw.strip()
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unrecognised or impossible date: {raw!r}")


def _validate_row(
    row: RawTransaction,
    config: AnalysisConfig,
    period: tuple[date | None, date | None],
) -> tuple[Transaction | None, list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    n = row.row_number

    def err(field_name: str, code: str, message: str) -> None:
        issues.append(ValidationIssue(n, field_name, code, message))

    txn_date: date | None = None
    if row.date is None or not row.date.strip():
        err("date", "missing_date", "Transaction date is missing.")
    else:
        try:
            txn_date = parse_date(row.date, config.date_formats)
        except ValueError as exc:
            err("date", "invalid_date", str(exc))
    if txn_date is not None:
        start, end = period
        if (start and txn_date < start) or (end and txn_date > end):
            err("date", "outside_period", f"Date {txn_date.isoformat()} is outside the statement period.")

    if row.narration is None or not row.narration.strip():
        err("narration", "missing_narration", "Narration is missing.")

    amounts: dict[str, Decimal] = {}
    for name, raw in (("debit", row.debit), ("credit", row.credit)):
        try:
            amounts[name] = parse_amount(raw)
        except AmountError as exc:
            code = "negative_amount" if "negative" in str(exc) else "invalid_amount"
            err(name, code, f"{name.capitalize()} {exc}.")

    balance: Decimal | None = None
    if row.balance is not None and row.balance.strip():
        try:
            balance = parse_amount(row.balance, allow_negative=True)
        except AmountError as exc:
            err("balance", "invalid_amount", f"Balance {exc}.")

    if len(amounts) == 2:
        debit, credit = amounts["debit"], amounts["credit"]
        if debit > 0 and credit > 0:
            err("amount", "both_debit_and_credit", "Row has both a nonzero debit and a nonzero credit.")
        elif debit == 0 and credit == 0:
            err("amount", "missing_amount", "Row has neither a debit nor a credit amount.")

    if issues:
        return None, issues

    assert txn_date is not None and row.narration is not None
    return (
        Transaction(
            row_number=n,
            date=txn_date,
            narration=row.narration,
            debit=amounts["debit"],
            credit=amounts["credit"],
            balance=balance,
            raw_debit=row.debit,
            raw_credit=row.credit,
            raw_balance=row.balance,
            mode=detect_mode(row.narration),
            counterparty=extract_counterparty(row.narration),
        ),
        [],
    )


def _running_balance_warnings(
    transactions: list[Transaction], opening: Decimal, tolerance: Decimal
) -> list[ValidationIssue]:
    """Check each stated running balance against the previous one. Only
    meaningful when no rows were rejected; mismatches are warnings."""
    warnings: list[ValidationIssue] = []
    running = opening
    for t in transactions:
        running = running + t.credit - t.debit
        if t.balance is not None:
            diff = t.balance - running
            if abs(diff) > tolerance:
                warnings.append(
                    ValidationIssue(
                        t.row_number,
                        "balance",
                        "running_balance_mismatch",
                        f"Stated balance {t.balance} differs from the computed running "
                        f"balance {running} by {diff}.",
                        Severity.WARNING,
                    )
                )
            running = t.balance
    return warnings


def validate_statement(
    rows: list[RawTransaction],
    opening_balance: str | Decimal,
    closing_balance: str | Decimal,
    config: AnalysisConfig = DEFAULT_CONFIG,
    period_start: date | None = None,
    period_end: date | None = None,
) -> ValidationReport:
    issues: list[ValidationIssue] = []
    valid: list[Transaction] = []
    invalid_rows: list[int] = []

    for row in rows:
        txn, row_issues = _validate_row(row, config, (period_start, period_end))
        issues.extend(row_issues)
        if txn is None:
            invalid_rows.append(row.row_number)
        else:
            valid.append(txn)

    reconciliation: Reconciliation | None = None
    try:
        opening = parse_amount(opening_balance, allow_negative=True)
        closing = parse_amount(closing_balance, allow_negative=True)
    except AmountError as exc:
        issues.append(ValidationIssue(None, "balance", "invalid_statement_balance", str(exc)))
    else:
        total_credits = sum((t.credit for t in valid), Decimal("0"))
        total_debits = sum((t.debit for t in valid), Decimal("0"))
        expected = opening + total_credits - total_debits
        difference = closing - expected
        tolerance = config.reconciliation_tolerance
        if invalid_rows:
            status = ReconciliationStatus.INCOMPLETE
        elif abs(difference) <= tolerance:
            status = ReconciliationStatus.PASSED
        else:
            status = ReconciliationStatus.FAILED
        reconciliation = Reconciliation(
            opening_balance=opening,
            total_credits=total_credits,
            total_debits=total_debits,
            expected_closing_balance=expected,
            stated_closing_balance=closing,
            difference=difference,
            tolerance=tolerance,
            status=status,
        )
        if not invalid_rows:
            issues.extend(_running_balance_warnings(valid, opening, tolerance))

    return ValidationReport(
        rows_received=len(rows),
        transactions=tuple(valid),
        issues=tuple(issues),
        reconciliation=reconciliation,
        credit_count=sum(1 for t in valid if t.credit > 0),
        debit_count=sum(1 for t in valid if t.debit > 0),
        invalid_row_numbers=tuple(invalid_rows),
    )
