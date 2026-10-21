from decimal import Decimal

from itr_intake import (
    CANONICAL_CATEGORIES,
    FLAG_LARGE_CREDIT,
    FLAG_RECURRING_CREDIT,
    Category,
    ReconciliationStatus,
    ReviewStatus,
    classify_statement,
    validate_statement,
)
from itr_intake.synthetic import BALANCED, UNBALANCED, load_synthetic_statement


def analyse(filename):
    s = load_synthetic_statement(filename)
    report = validate_statement(s.rows, s.opening_balance, s.closing_balance,
                                period_start=s.period_start, period_end=s.period_end)
    return s, report, classify_statement(report.transactions, s.profile)


def test_dataset_is_labelled_synthetic():
    for name in (BALANCED, UNBALANCED):
        assert "SYNTHETIC" in load_synthetic_statement(name).notice


def test_balanced_statement_reconciles_with_no_issues():
    s, report, _ = analyse(BALANCED)
    assert report.rows_received == len(s.rows) == 24
    assert report.valid_count == 24 and report.invalid_count == 0
    assert report.issues == ()
    assert report.reconciliation.status is ReconciliationStatus.PASSED
    assert report.reconciliation.difference == Decimal("0")


def test_unbalanced_statement_fails_with_reported_difference():
    _, report, _ = analyse(UNBALANCED)
    rec = report.reconciliation
    assert rec.status is ReconciliationStatus.FAILED
    assert rec.difference == Decimal("1000.00")
    assert report.valid_count == report.rows_received


def test_balanced_statement_classification():
    _, _, txns = analyse(BALANCED)
    by_row = {t.row_number: t for t in txns}
    expected = {
        1: Category.SALARY_PENSION,
        2: Category.SELF_TRANSFER,
        3: Category.FAMILY_TRANSFER,
        4: Category.INVESTMENTS_OTHERS,
        5: Category.INVESTMENTS_TAX_SAVING,
        6: Category.BANK_CHARGES,
        7: Category.OTHERS_NEEDS_REVIEW,
        8: Category.FAMILY_TRANSFER,
        11: Category.LOAN_EMI,
        13: Category.CASH_WITHDRAWAL,
        14: Category.INSURANCE_HEALTH,
        16: Category.INCOME_TAX_REFUND,
        18: Category.PERSONAL_EXPENSES,
        19: Category.SELF_TRANSFER,
        20: Category.REVERSALS_REFUNDS,
        22: Category.BANK_CHARGES,
        23: Category.INTEREST_SAVINGS,
        24: Category.OTHERS_NEEDS_REVIEW,
    }
    for row, category in expected.items():
        assert by_row[row].category is category, (row, by_row[row].narration)

    assert FLAG_LARGE_CREDIT in by_row[7].flags
    assert by_row[19].review_status is ReviewStatus.NEEDS_CONFIRMATION  # name at unlisted bank
    assert all(FLAG_RECURRING_CREDIT in by_row[r].flags for r in (9, 15, 21))
    assert all(t.category.value in CANONICAL_CATEGORIES for t in txns)
    assert all(t.classification_reason for t in txns)
