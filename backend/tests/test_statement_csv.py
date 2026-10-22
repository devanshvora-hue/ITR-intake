"""CSV statement parsing (Stage 5.7). Synthetic text only."""

from decimal import Decimal

import pytest
from openpyxl import Workbook

from itr_intake import statement_import as si
from itr_intake.classifier import classify_statement
from itr_intake.config import ClientProfile
from itr_intake.models import RawTransaction
from itr_intake.validation import validate_statement
from itr_intake.workbook import StatementMetadata, build_workbook

HEADER = "Date,Narration,Debit,Credit,Balance\n"
FY = "2025-26"


def csv(*lines: str, header: str = HEADER) -> bytes:
    return (header + "\n".join(lines) + "\n").encode("utf-8")


def parse(data: bytes, fy: str | None = FY) -> si.ImportResult:
    return si.parse_csv(data, financial_year=fy)


VALID = csv("01/04/2025,UPI/1001/SYNTHETIC SHOP,250.00,,9750.00",
            "02/04/2025,NEFT SALARY SYNTHETIC CO,,50000.00,59750.00",
            "03/04/2025,ATM WDL SYNTHETIC,5000.00,,54750.00")


# === valid files ========================================================================================

def test_a_valid_csv_is_extracted_exactly():
    r = parse(VALID)
    assert r.status == si.EXTRACTED and r.review_reasons == () and r.rejected == ()
    assert [t.row_number for t in r.transactions] == [1, 2, 3]
    assert r.transactions[0] == RawTransaction(1, "01/04/2025", "UPI/1001/SYNTHETIC SHOP", "250.00", None, "9750.00")
    assert str(r.period_start) == "2025-04-01" and str(r.period_end) == "2025-04-03"


def test_optional_balance_column_may_be_missing():
    r = parse(csv("01/04/2025,SYNTHETIC A,100.00,", "02/04/2025,SYNTHETIC B,,200.00",
                  header="Txn Date,Description,Withdrawal Amt,Deposit Amt\n"))
    assert r.status == si.EXTRACTED and len(r.transactions) == 2
    assert r.transactions[1].balance is None


def test_a_credit_only_file_is_accepted():
    r = parse(csv("01/04/2025,INTEREST SYNTHETIC,25.00", header="Date,Particulars,Credit\n"))
    assert r.status == si.EXTRACTED and r.transactions[0].credit == "25.00"


@pytest.mark.parametrize("raw", ["01/04/2025", "01-04-2025", "01.04.2025", "2025-04-01", "01-Apr-2025",
                                 "01 Apr 2025", "01/04/25"])
def test_supported_date_formats(raw):
    r = parse(csv(f"{raw},SYNTHETIC,10.00,,"), fy=None)
    assert r.status == si.EXTRACTED, r.rejected


def test_dates_are_read_day_first_only():
    # 02/03/2025 is 2 March (documented day-first), never 3 February.
    r = parse(csv("02/03/2025,SYNTHETIC,10.00,,"), fy=None)
    assert str(r.period_start) == "2025-03-02"


@pytest.mark.parametrize("raw", ["31/02/2025", "04/13/2025", "2025/04/01", "1st April", "45/45/2025", "tomorrow"])
def test_invalid_and_ambiguous_dates_are_rejected_by_row(raw):
    r = parse(csv("01/04/2025,SYNTHETIC OK,10.00,,", f"{raw},SYNTHETIC BAD,10.00,,"))
    assert r.status == si.MANUAL_REVIEW
    assert [(x.row_number, x.codes) for x in r.rejected] == [(2, ("invalid_date",))]
    assert len(r.transactions) == 1


@pytest.mark.parametrize("raw", ["1,23,456.78", "123456.78", "₹ 1,23,456.78", "INR 123,456.78", "1,234"])
def test_supported_amount_formats(raw):
    r = parse(csv(f'01/04/2025,SYNTHETIC,"{raw}",,'), fy=None)
    assert r.status == si.EXTRACTED, r.rejected


@pytest.mark.parametrize("debit, credit, code", [
    ("abc", "", "debit_invalid_amount"),
    ("1.234", "", "debit_invalid_amount"),
    ("-50.00", "", "negative_amount"),
    ("(50.00)", "", "debit_negative_amount"),
    ("10.00", "20.00", "both_debit_and_credit"),
    ("", "", "missing_amount"),
    ("12..5", "", "debit_invalid_amount"),
])
def test_invalid_and_contradictory_amounts(debit, credit, code):
    r = parse(csv(f"01/04/2025,SYNTHETIC,{debit},{credit},"))
    assert r.status == si.MANUAL_REVIEW and r.transactions == ()
    assert r.rejected[0].row_number == 1 and code in r.rejected[0].codes


def test_balance_may_carry_dr_or_cr():
    r = parse(csv("01/04/2025,SYNTHETIC,100.00,,1000.00 Dr", "02/04/2025,SYNTHETIC,,100.00,900.00 Dr"))
    assert r.status == si.EXTRACTED, (r.review_reasons, r.rejected)
    assert r.transactions[0].balance == "-1000.00"


def test_missing_narration_and_date_are_never_filled_in():
    r = parse(csv(",SYNTHETIC NO DATE,10.00,,", "01/04/2025,,10.00,,"))
    assert r.transactions == ()
    assert {x.row_number: x.codes for x in r.rejected} == {1: ("missing_date",), 2: ("missing_narration",)}


# === file-level problems ================================================================================

@pytest.mark.parametrize("data, code", [
    (b"", "empty_file"),
    (b"   \n\n", "empty_file"),
    (HEADER.encode(), "no_data_rows"),
    (b"Date,Narration,Debit,Credit\n\n\n", "no_data_rows"),
    (b"When,What,How much\n01/04/2025,SYNTHETIC,10\n", "missing_required_columns"),
    (b"Date;Narration;Debit;Credit\n01/04/2025;SYNTHETIC;10.00;\n", "unsupported_delimiter"),
    ("Date,Narration,Debit\n01/04/2025,CAF\xe9,1.00\n".encode("latin-1"), "unsupported_encoding"),
    (b"Date,Narration,Debit\n01/04/2025,SYN\x00,1.00\n", "unsupported_encoding"),
    (b'Date,Narration,Debit\n01/04/2025,"unterminated,1.00\n', "malformed_csv"),
])
def test_unusable_files_are_rejected(data, code):
    r = parse(data)
    assert r.status == si.REJECTED and r.error_code == code and r.transactions == ()


def test_a_utf8_bom_and_whitespace_are_accepted():
    data = "﻿ Date , Narration ,Debit,Credit\n 01/04/2025 ,  SYNTHETIC  , 10.00 ,\n".encode("utf-8")
    r = parse(data)
    assert r.status == si.EXTRACTED and r.transactions[0].narration == "SYNTHETIC"


def test_a_preamble_before_the_header_is_skipped():
    data = ("Synthetic Bank\nAccount: XXXX0000\n\n" + HEADER + "01/04/2025,SYNTHETIC,10.00,,90.00\n").encode()
    assert parse(data).status == si.EXTRACTED


def test_too_many_rows_and_columns_are_rejected():
    rows = [f"01/04/2025,SYNTHETIC {i},1.00,," for i in range(si.MAX_CSV_ROWS + 1)]
    assert parse(csv(*rows)).error_code == "too_many_rows"
    wide = ",".join(f"c{i}" for i in range(si.MAX_CSV_COLUMNS + 1))
    assert parse(f"Date,Narration,Debit,{wide}\n".encode()).error_code == "too_many_columns"


def test_a_row_with_the_wrong_number_of_cells_is_rejected_not_dropped():
    r = parse(csv("01/04/2025,SYNTHETIC,10.00,,90.00", "02/04/2025,SYNTHETIC,10.00"))
    assert [(x.row_number, x.codes) for x in r.rejected] == [(2, ("column_count_mismatch",))]
    assert r.status == si.MANUAL_REVIEW and "rows_rejected" in r.review_reasons


def test_an_oversized_cell_is_rejected():
    r = parse(csv(f"01/04/2025,{'X' * (si.MAX_FIELD_CHARS + 1)},10.00,,"))
    assert r.rejected[0].codes == ("field_too_long",)


def test_summary_rows_are_counted_not_rejected():
    r = parse(csv("01/04/2025,SYNTHETIC,10.00,,90.00", ",Closing Balance,,,90.00", ",Total,10.00,,"))
    assert r.summary_rows == 2 and r.rejected == () and len(r.transactions) == 1


# === duplicates, balances and periods ==========================================================================

def test_identical_rows_without_balances_are_flagged_not_removed():
    r = parse(csv("01/04/2025,UPI SYNTHETIC TEA,20.00,", "01/04/2025,UPI SYNTHETIC TEA,20.00,",
                  header="Date,Narration,Debit,Credit\n"))
    assert len(r.transactions) == 2 and r.duplicate_rows == (1, 2)
    assert r.status == si.MANUAL_REVIEW and "duplicate_looking_rows" in r.review_reasons


def test_legitimate_repeats_with_different_balances_are_not_duplicates():
    r = parse(csv("01/04/2025,UPI SYNTHETIC TEA,20.00,,980.00", "01/04/2025,UPI SYNTHETIC TEA,20.00,,960.00"))
    assert r.duplicate_rows == () and r.status == si.EXTRACTED


def test_a_broken_balance_chain_needs_review():
    r = parse(csv("01/04/2025,SYNTHETIC A,100.00,,900.00", "02/04/2025,SYNTHETIC B,100.00,,700.00"))
    assert r.status == si.MANUAL_REVIEW and "balance_chain_broken" in r.review_reasons
    assert len(r.transactions) == 2  # nothing removed


def test_newest_first_statements_are_checked_in_date_order():
    r = parse(csv("02/04/2025,SYNTHETIC B,100.00,,800.00", "01/04/2025,SYNTHETIC A,100.00,,900.00"))
    assert r.status == si.EXTRACTED, r.review_reasons


def test_rows_with_balances_on_only_some_rows_need_review():
    r = parse(csv("01/04/2025,SYNTHETIC A,100.00,,900.00", "02/04/2025,SYNTHETIC B,100.00,,"))
    assert "balance_missing_on_rows" in r.review_reasons


def test_dates_outside_the_financial_year_need_review():
    r = parse(csv("01/04/2024,SYNTHETIC OLD,10.00,,"))
    assert r.status == si.MANUAL_REVIEW and "dates_outside_financial_year" in r.review_reasons


def test_amounts_stay_exact_decimals():
    rows = [f"0{d}/04/2025,SYNTHETIC {d},,0.10,{Decimal('0.10') * d}" for d in range(1, 4)]
    r = parse(csv(*rows))
    assert r.status == si.EXTRACTED, r.review_reasons  # 0.1 + 0.1 + 0.1 == 0.3 exactly
    report = validate_statement(list(r.transactions), "0", "0.30")
    assert report.reconciliation.passed and report.reconciliation.total_credits == Decimal("0.30")


# === safety ================================================================================================

def test_results_never_echo_row_contents():
    r = parse(csv("01/04/2025,SECRET-NARRATION-XYZ,abc,,"))
    assert "SECRET" not in repr(r) and "SECRET" not in repr(r.rejected)


@pytest.mark.parametrize("text", ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\tX"])
def test_formula_like_text_is_neutralised_for_export(text):
    assert si.neutralise_formula(text).startswith("'")
    assert si.neutralise_formula("NEFT SALARY") == "NEFT SALARY"


def test_extracted_rows_fit_the_existing_classifier_and_workbook_contracts():
    r = parse(csv('01/04/2025,"=HYPERLINK(""http://example.test"")",100.00,,900.00',
                  "02/04/2025,NEFT SALARY SYNTHETIC CO,,1000.00,1900.00"))
    report = validate_statement(list(r.transactions), "1000.00", "1900.00")
    assert report.reconciliation.passed
    classified = classify_statement(report.transactions, ClientProfile(name="Synthetic Person"))
    wb = build_workbook(report, classified, StatementMetadata(client_name="Synthetic Person",
                                                               client_reference="IT-SYNTH-000000",
                                                               bank_name="Synthetic Bank", account_number="1234",
                                                               financial_year=FY))
    assert isinstance(wb, Workbook)
    cells = [c for ws in wb.worksheets for row in ws.iter_rows() for c in row
             if isinstance(c.value, str) and c.value.startswith("=HYPERLINK")]
    assert cells and all(c.data_type == "s" for c in cells)  # written as text, not a formula
