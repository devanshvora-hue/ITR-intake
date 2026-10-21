from datetime import date
from decimal import Decimal

import pytest

from itr_intake import (
    AnalysisConfig,
    RawTransaction,
    ReconciliationStatus,
    Severity,
    parse_amount,
    validate_statement,
)
from itr_intake.validation import AmountError


def raw(n, date_="01/04/2025", narration="SYNTHETIC ENTRY", debit="", credit="", balance=None):
    return RawTransaction(n, date_, narration, debit, credit, balance)


def codes(report):
    return {(i.row_number, i.code) for i in report.issues}


# --- reconciliation -------------------------------------------------------

def test_valid_reconciliation_passes_with_zero_difference():
    rows = [
        raw(1, credit="1,000.50", balance="11,000.50"),
        raw(2, debit="250.25", balance="10,750.25"),
    ]
    report = validate_statement(rows, "10000.00", "10750.25")
    rec = report.reconciliation
    assert rec.status is ReconciliationStatus.PASSED and rec.passed
    assert rec.total_credits == Decimal("1000.50")
    assert rec.total_debits == Decimal("250.25")
    assert rec.expected_closing_balance == Decimal("10750.25")
    assert rec.difference == Decimal("0")
    assert report.rows_received == 2 and report.valid_count == 2 and report.invalid_count == 0
    assert report.credit_count == 1 and report.debit_count == 1
    assert report.errors == ()


def test_failed_reconciliation_reports_exact_difference():
    rows = [raw(1, credit="500.00"), raw(2, debit="200.00")]
    report = validate_statement(rows, "1000.00", "1400.00")
    rec = report.reconciliation
    assert rec.status is ReconciliationStatus.FAILED and not rec.passed
    assert rec.expected_closing_balance == Decimal("1300.00")
    assert rec.stated_closing_balance == Decimal("1400.00")
    assert rec.difference == Decimal("100.00")


def test_difference_within_tolerance_passes_and_outside_fails():
    rows = [raw(1, credit="100.00")]
    assert validate_statement(rows, "0", "100.01").reconciliation.passed
    assert not validate_statement(rows, "0", "100.02").reconciliation.passed
    strict = AnalysisConfig(reconciliation_tolerance=Decimal("0"))
    assert not validate_statement(rows, "0", "100.01", strict).reconciliation.passed


def test_decimal_arithmetic_has_no_float_drift():
    rows = [raw(i, credit="0.10") for i in range(1, 11)]
    report = validate_statement(rows, "0", "1.00", AnalysisConfig(reconciliation_tolerance=Decimal("0")))
    assert report.reconciliation.passed
    assert report.reconciliation.total_credits == Decimal("1.00")


def test_invalid_rows_make_reconciliation_incomplete_not_passed():
    # Excluding the bad row would make the totals balance; that must not count as a pass.
    rows = [raw(1, credit="100.00"), raw(2, credit="abc")]
    report = validate_statement(rows, "0", "100.00")
    assert report.reconciliation.status is ReconciliationStatus.INCOMPLETE
    assert not report.reconciliation.passed
    assert report.invalid_row_numbers == (2,)


def test_running_balance_mismatch_is_reported_as_warning():
    rows = [raw(1, credit="100.00", balance="100.00"), raw(2, debit="10.00", balance="95.00")]
    report = validate_statement(rows, "0", "95.00")
    warnings = [i for i in report.issues if i.code == "running_balance_mismatch"]
    assert len(warnings) == 1 and warnings[0].row_number == 2
    assert warnings[0].severity is Severity.WARNING


# --- invalid transactions -------------------------------------------------

@pytest.mark.parametrize(
    "row, expected_code",
    [
        (raw(1, date_=None, credit="1"), "missing_date"),
        (raw(1, date_="  ", credit="1"), "missing_date"),
        (raw(1, date_="31/02/2025", credit="1"), "invalid_date"),
        (raw(1, date_="2025/13/45", credit="1"), "invalid_date"),
        (raw(1, narration="", credit="1"), "missing_narration"),
        (raw(1, narration=None, credit="1"), "missing_narration"),
        (raw(1, debit="10.00", credit="5.00"), "both_debit_and_credit"),
        (raw(1, debit="-10.00"), "negative_amount"),
        (raw(1, credit="-0.01"), "negative_amount"),
        (raw(1, credit="12x"), "invalid_amount"),
        (raw(1), "missing_amount"),
        (raw(1, credit="5", balance="n/a"), "invalid_amount"),
    ],
)
def test_invalid_rows_are_rejected_with_reason(row, expected_code):
    report = validate_statement([row], "0", "0")
    assert (1, expected_code) in codes(report)
    assert report.valid_count == 0 and report.invalid_count == 1


def test_date_outside_statement_period_is_rejected():
    report = validate_statement(
        [raw(1, date_="15/03/2025", credit="1")], "0", "1",
        period_start=date(2025, 4, 1), period_end=date(2025, 6, 30),
    )
    assert (1, "outside_period") in codes(report)


def test_zero_on_one_side_is_allowed():
    report = validate_statement([raw(1, debit="0.00", credit="50.00")], "0", "50")
    assert report.valid_count == 1 and report.reconciliation.passed


def test_negative_running_balance_is_allowed():
    report = validate_statement([raw(1, debit="50.00", balance="-50.00")], "0", "-50.00")
    assert report.valid_count == 1 and report.reconciliation.passed


# --- preservation ---------------------------------------------------------

def test_original_amounts_and_narration_are_preserved_exactly():
    narration = "  NEFT CR-XXXX0001-Example Payer-Ref/123  "
    report = validate_statement([raw(1, narration=narration, credit="1,23,456.78", balance="1,23,456.78")], "0", "123456.78")
    t = report.transactions[0]
    assert t.narration == narration
    assert t.raw_credit == "1,23,456.78" and t.raw_balance == "1,23,456.78"
    assert t.credit == Decimal("123456.78") and isinstance(t.credit, Decimal)
    assert t.debit == Decimal("0")


def test_amounts_are_not_rounded():
    report = validate_statement([raw(1, credit="10.005")], "0", "10.005")
    assert report.transactions[0].credit == Decimal("10.005")


def test_parse_amount_rejects_non_finite_values():
    for bad in ("NaN", "Infinity"):
        with pytest.raises(AmountError):
            parse_amount(bad)
