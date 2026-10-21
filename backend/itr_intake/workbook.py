"""Internal Excel workbook for the CA firm.

Built from a `ValidationReport` and the classifier's output; this module does
not classify anything itself. The workbook is for internal CA review only and
must never be shown to the client.

Live formulas vs. values written by Python
------------------------------------------
Live formulas (they update when a category is changed in "All Transactions"):
  - Summary category table: count, debit, credit and net per category, and
    the total row.
  - Summary reconciliation: total credits, total debits, expected closing
    balance, difference and live status.
  - Summary key figures.
  - Totals row on each category sheet (sums of that sheet's own rows).
  - "Bank amount", "Difference" and "Status" on the AIS / 26AS sheet.
Written by Python at generation time (do NOT update on reclassification):
  - Which rows appear on each category sheet and on "Needs Review".
  - "Status at generation" in the reconciliation block.
  - Row counts from validation (received / valid / rejected).
"""

from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter, quote_sheetname
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.worksheet import Worksheet

from .categories import CANONICAL_CATEGORIES, Category
from .config import DEFAULT_CONFIG, AnalysisConfig
from .models import Direction, ReviewStatus, Transaction
from .validation import ReconciliationStatus, ValidationReport

DISCLAIMER = (
    "This summary has been prepared only from the bank statement(s) provided, as an aid to "
    "preparing the Income Tax Return. It is not a tax computation, opinion or certification. "
    "Classification is based on bank narrations and transaction patterns and may not reflect "
    "the true nature of every transaction. Before filing, the figures must be checked and "
    "reconciled with Form 26AS, the Annual Information Statement (AIS) and the Taxpayer "
    "Information Summary (TIS), and, where applicable, with capital gains statements from "
    "brokers / RTAs. The user is advised to consult a Chartered Accountant before filing the return."
)

INTERNAL_BANNER = "INTERNAL – for CA firm review only. Do not share with the client."

# Indian digit grouping (1,23,45,678.00). Negative values below -99,999.99 fall
# through to the last section and show Western grouping; Excel number formats
# allow only two conditions.
INR_FORMAT = r"[>=10000000]##\,##\,##\,##0.00;[>=100000]##\,##\,##0.00;##,##0.00"
DATE_FORMAT = "DD-MM-YYYY"

SHEET_SUMMARY = "Summary"
SHEET_ALL = "All Transactions"
SHEET_REVIEW = "Needs Review"
SHEET_AIS = "AIS - 26AS Reconciliation"
SHEET_LISTS = "Lists"

STATUS_RECONCILED = "RECONCILED"
STATUS_NOT_RECONCILED = "NOT RECONCILED"
STATUS_INCOMPLETE = "INCOMPLETE – rows rejected"

_RESERVED_NAMES = {SHEET_SUMMARY, SHEET_ALL, SHEET_REVIEW, SHEET_AIS, SHEET_LISTS, "History"}
_INVALID_SHEET_CHARS = set('[]:*?/\\')

# All Transactions column layout (1-based).
ALL_COLUMNS = (
    ("Row #", 7), ("Date", 12), ("Mode", 13), ("Counterparty", 24), ("Debit (₹)", 15),
    ("Credit (₹)", 15), ("Balance (₹)", 16), ("Narration", 58), ("Category", 32),
    ("Confidence", 11), ("Review status", 18), ("Classification reason", 70),
    ("Flags", 18), ("Rule", 26),
)
COL = {name: i for i, (name, _) in enumerate(ALL_COLUMNS, start=1)}

CATEGORY_COLUMNS = (
    ("Date", 12), ("Mode", 13), ("Counterparty", 24), ("Debit (₹)", 15), ("Credit (₹)", 15),
    ("Balance (₹)", 16), ("Narration", 58), ("Remarks", 70),
)

# Possible categories listed on "Needs Review" for unclassified rows. These are
# prompts for the CA, not conclusions.
_CANDIDATES = {
    Direction.CREDIT: (
        Category.BUSINESS_RECEIPTS, Category.RENT_RECEIVED, Category.GIFTS_NON_RELATIVES,
        Category.LOANS_RECEIVED, Category.INVESTMENT_REDEMPTION,
    ),
    Direction.DEBIT: (
        Category.PERSONAL_EXPENSES, Category.BUSINESS_EXPENSES, Category.RENT_PAID,
        Category.LOANS_GIVEN, Category.DONATIONS,
    ),
}

# --- styling ---------------------------------------------------------------

_INK = "1D1B18"
_TEAL = "0F6B5F"
_HEADER_FILL = PatternFill("solid", fgColor="E3EFE9")
_SECTION_FONT = Font(bold=True, size=12, color=_TEAL)
_TITLE_FONT = Font(bold=True, size=15, color=_INK)
_BOLD = Font(bold=True)
_RED_FILL = PatternFill("solid", fgColor="F5D0C8")
_RED_FONT = Font(bold=True, color="8F1D0B")
_GREEN_FILL = PatternFill("solid", fgColor="CFE8DC")
_GREEN_FONT = Font(bold=True, color="0A4F46")
_AMBER_FILL = PatternFill("solid", fgColor="F7ECD6")
_BANNER_FONT = Font(bold=True, color="8A5A10")
_TOTAL_BORDER = Border(top=Side(style="thin", color=_INK))
_WRAP_TOP = Alignment(wrap_text=True, vertical="top")


@dataclass(frozen=True)
class StatementMetadata:
    client_name: str
    client_reference: str
    bank_name: str | None = None
    account_number: str | None = None
    financial_year: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    data_source_note: str | None = None


@dataclass(frozen=True)
class SupportingReportEntry:
    """One figure taken from an AIS, Form 26AS or TIS supplied by the client.
    The sheet is created only when at least one entry is supplied."""

    source: str  # e.g. "AIS", "26AS", "TIS"
    information_type: str
    reported_amount: Decimal
    bank_category: Category | None = None
    direction: Direction = Direction.CREDIT
    remarks: str = ""


@dataclass
class _Refs:
    """Cell addresses on Summary that other sheets refer to."""

    tolerance: str = ""
    extra: dict[str, str] = field(default_factory=dict)


def mask_account(number: str | None) -> str:
    if not number:
        return "Not provided"
    digits = "".join(ch for ch in number if ch.isdigit())
    return f"XXXX{digits[-4:]}" if len(digits) >= 4 else "XXXX"


def safe_sheet_name(name: str, taken: set[str]) -> str:
    """Excel-safe, unique (case-insensitive) sheet name of at most 31 chars."""
    cleaned = "".join("-" if ch in _INVALID_SHEET_CHARS else ch for ch in name)
    cleaned = " ".join(cleaned.split()).strip("'") or "Sheet"
    base = cleaned[:31].rstrip()
    lowered = {t.lower() for t in taken} | {r.lower() for r in _RESERVED_NAMES}
    candidate, n = base, 2
    while candidate.lower() in lowered:
        suffix = f" ({n})"
        candidate = base[: 31 - len(suffix)].rstrip() + suffix
        n += 1
    return candidate


def _ref(sheet: str, col: int, first: int, last: int) -> str:
    letter = get_column_letter(col)
    return f"{quote_sheetname(sheet)}!${letter}${first}:${letter}${last}"


def _header(ws: Worksheet, row: int, columns: tuple[tuple[str, int], ...]) -> None:
    for i, (name, width) in enumerate(columns, start=1):
        cell = ws.cell(row=row, column=i, value=name)
        cell.font = _BOLD
        cell.fill = _HEADER_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = width


def _money(cell) -> None:
    cell.number_format = INR_FORMAT


def _ordered(transactions: list[Transaction]) -> list[Transaction]:
    return sorted(transactions, key=lambda t: (t.date, t.row_number))


def _needs_review(t: Transaction) -> bool:
    return (
        t.review_status is not ReviewStatus.AUTO_CLASSIFIED
        or t.category is Category.OTHERS_NEEDS_REVIEW
        or bool(t.flags)
    )


def _remarks(t: Transaction) -> str:
    status = "" if t.review_status is ReviewStatus.AUTO_CLASSIFIED else f"[{t.review_status}] "
    flags = f" Flags: {', '.join(t.flags)}." if t.flags else ""
    return f"{status}{t.classification_reason}{flags}"


# --- sheets ------------------------------------------------------------------

def _write_lists(wb: Workbook) -> str:
    ws = wb.create_sheet(SHEET_LISTS)
    for i, name in enumerate(CANONICAL_CATEGORIES, start=1):
        ws.cell(row=i, column=1, value=name)
    ws.sheet_state = "hidden"
    return f"{quote_sheetname(SHEET_LISTS)}!$A$1:$A${len(CANONICAL_CATEGORIES)}"


def _write_all_transactions(wb: Workbook, txns: list[Transaction], list_ref: str) -> int:
    ws = wb.create_sheet(SHEET_ALL)
    _header(ws, 1, ALL_COLUMNS)
    for r, t in enumerate(txns, start=2):
        values = {
            "Row #": t.row_number,
            "Date": t.date,
            "Mode": str(t.mode),
            "Counterparty": t.counterparty or "",
            "Debit (₹)": t.debit if t.debit else None,
            "Credit (₹)": t.credit if t.credit else None,
            "Balance (₹)": t.balance,
            "Narration": t.narration,
            "Category": str(t.category),
            "Confidence": str(t.confidence),
            "Review status": str(t.review_status),
            "Classification reason": t.classification_reason,
            "Flags": ", ".join(t.flags),
            "Rule": t.matched_rule or "",
        }
        for name, value in values.items():
            cell = ws.cell(row=r, column=COL[name], value=value)
            if name == "Date":
                cell.number_format = DATE_FORMAT
            elif name.endswith("(₹)"):
                _money(cell)
            elif name in ("Narration", "Classification reason"):
                cell.alignment = _WRAP_TOP
            if name == "Narration":
                # Keep narrations as literal text even if they start with "=".
                cell.data_type = "s"
    last = max(len(txns) + 1, 2)
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(ALL_COLUMNS))}{last}"
    dv = DataValidation(type="list", formula1=f"={list_ref}", allow_blank=False, showErrorMessage=True)
    dv.error = "Choose one of the 28 canonical categories."
    dv.add(f"{get_column_letter(COL['Category'])}2:{get_column_letter(COL['Category'])}{last}")
    ws.add_data_validation(dv)
    return last


def _write_category_sheet(wb: Workbook, category: Category, txns: list[Transaction], taken: set[str]) -> str:
    name = safe_sheet_name(str(category), taken)
    taken.add(name)
    ws = wb.create_sheet(name)
    ws.cell(row=1, column=1, value=str(category)).font = _SECTION_FONT
    ws.cell(row=1, column=4, value="Snapshot at generation; see Summary for live totals.").font = Font(italic=True, color="57524A")
    _header(ws, 2, CATEGORY_COLUMNS)
    for r, t in enumerate(txns, start=3):
        row = (t.date, str(t.mode), t.counterparty or "", t.debit or None, t.credit or None, t.balance, t.narration, _remarks(t))
        for c, value in enumerate(row, start=1):
            cell = ws.cell(row=r, column=c, value=value)
            if c == 1:
                cell.number_format = DATE_FORMAT
            elif c in (4, 5, 6):
                _money(cell)
            elif c in (7, 8):
                cell.alignment = _WRAP_TOP
                if c == 7:
                    cell.data_type = "s"
    first, last = 3, len(txns) + 2
    total_row = last + 1
    ws.cell(row=total_row, column=1, value="Total").font = _BOLD
    for c in (4, 5):
        letter = get_column_letter(c)
        cell = ws.cell(row=total_row, column=c, value=f"=SUM({letter}{first}:{letter}{last})")
        cell.font = _BOLD
        cell.border = _TOTAL_BORDER
        _money(cell)
    ws.freeze_panes = "A3"
    ws.auto_filter.ref = f"A2:{get_column_letter(len(CATEGORY_COLUMNS))}{last}"
    return name


def _write_needs_review(wb: Workbook, txns: list[Transaction]) -> None:
    ws = wb.create_sheet(SHEET_REVIEW)
    columns = (
        ("Row #", 7), ("Date", 12), ("Debit (₹)", 15), ("Credit (₹)", 15), ("Narration", 50),
        ("Current category", 30), ("Suggested category", 44), ("Review status", 18),
        ("Flags", 18), ("Reason", 70),
    )
    _header(ws, 1, columns)
    rows = [t for t in txns if _needs_review(t)]
    for r, t in enumerate(rows, start=2):
        if t.category is Category.OTHERS_NEEDS_REVIEW:
            options = "; ".join(str(c) for c in _CANDIDATES[t.direction])
            suggested = f"Not determined. Possible categories for CA consideration: {options}"
        else:
            suggested = f"{t.category} (classifier result – confirm)"
        values = (
            t.row_number, t.date, t.debit or None, t.credit or None, t.narration, str(t.category),
            suggested, str(t.review_status), ", ".join(t.flags), t.classification_reason,
        )
        for c, value in enumerate(values, start=1):
            cell = ws.cell(row=r, column=c, value=value)
            if c == 2:
                cell.number_format = DATE_FORMAT
            elif c in (3, 4):
                _money(cell)
            elif c in (5, 7, 10):
                cell.alignment = _WRAP_TOP
                if c == 5:
                    cell.data_type = "s"
    if not rows:
        ws.cell(row=2, column=1, value="No transactions need review.")
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{max(len(rows) + 1, 2)}"


def _write_summary(
    ws: Worksheet,
    report: ValidationReport,
    txns: list[Transaction],
    meta: StatementMetadata,
    config: AnalysisConfig,
    last: int,
    refs: _Refs,
) -> None:
    ws.column_dimensions["A"].width = 44
    for letter in "BCDE":
        ws.column_dimensions[letter].width = 18
    ws.column_dimensions["F"].width = 30

    def label_value(row: int, label: str, value, money: bool = False, fmt: str | None = None):
        ws.cell(row=row, column=1, value=label).font = _BOLD
        cell = ws.cell(row=row, column=2, value=value)
        if money:
            _money(cell)
        if fmt:
            cell.number_format = fmt
        return cell

    ws["A1"] = "ITR Intake – Bank Statement Summary"
    ws["A1"].font = _TITLE_FONT
    ws["A2"] = INTERNAL_BANNER
    ws["A2"].font = _BANNER_FONT
    ws["A2"].fill = _AMBER_FILL
    ws.merge_cells("A2:F2")

    # Client and statement details.
    row = 4
    ws.cell(row=row, column=1, value="Client and statement").font = _SECTION_FONT
    period = (
        f"{meta.period_start:%d-%m-%Y} to {meta.period_end:%d-%m-%Y}"
        if meta.period_start and meta.period_end else "Not provided"
    )
    details = [
        ("Client name", meta.client_name),
        ("Client reference", meta.client_reference),
        ("Bank", meta.bank_name or "Not provided"),
        ("Account number", mask_account(meta.account_number)),
        ("Financial year", meta.financial_year or "Not provided"),
        ("Statement period", period),
        ("Generated on", datetime.now().strftime("%d-%m-%Y %H:%M")),
        ("Rows received", report.rows_received),
        ("Rows accepted", report.valid_count),
        ("Rows rejected by validation", report.invalid_count),
    ]
    if meta.data_source_note:
        details.append(("Data source", meta.data_source_note))
    for label, value in details:
        row += 1
        cell = label_value(row, label, value)
        if label == "Rows rejected by validation" and report.invalid_count:
            cell.font = _RED_FONT
            cell.fill = _RED_FILL

    all_debit = _ref(SHEET_ALL, COL["Debit (₹)"], 2, last)
    all_credit = _ref(SHEET_ALL, COL["Credit (₹)"], 2, last)
    all_cat = _ref(SHEET_ALL, COL["Category"], 2, last)

    # Reconciliation.
    row += 2
    ws.cell(row=row, column=1, value="Balance reconciliation").font = _SECTION_FONT
    rec = report.reconciliation
    if rec is None:
        row += 1
        cell = ws.cell(row=row, column=1, value="Reconciliation could not be performed: opening or closing balance is invalid.")
        cell.font = _RED_FONT
        cell.fill = _RED_FILL
    else:
        row += 1
        opening = label_value(row, "Opening balance (statement)", rec.opening_balance, money=True).coordinate
        row += 1
        credits = label_value(row, "Total credits", f"=SUM({all_credit})", money=True).coordinate
        row += 1
        debits = label_value(row, "Total debits", f"=SUM({all_debit})", money=True).coordinate
        row += 1
        expected = label_value(row, "Expected closing balance", f"={opening}+{credits}-{debits}", money=True).coordinate
        row += 1
        stated = label_value(row, "Closing balance (statement)", rec.stated_closing_balance, money=True).coordinate
        row += 1
        diff = label_value(row, "Difference (statement − expected)", f"={stated}-{expected}", money=True).coordinate
        row += 1
        tol = label_value(row, "Tolerance", rec.tolerance, money=True).coordinate
        refs.tolerance = tol
        rejected = f"B{_find_label_row(ws, 'Rows rejected by validation')}"
        row += 1
        live = label_value(
            row, "Status (live)",
            f'=IF({rejected}>0,"{STATUS_INCOMPLETE}",IF(ABS({diff})<={tol},"{STATUS_RECONCILED}","{STATUS_NOT_RECONCILED}"))',
        )
        for value, fill, font in (
            (STATUS_RECONCILED, _GREEN_FILL, _GREEN_FONT),
            (STATUS_NOT_RECONCILED, _RED_FILL, _RED_FONT),
            (STATUS_INCOMPLETE, _RED_FILL, _RED_FONT),
        ):
            ws.conditional_formatting.add(live.coordinate, CellIsRule(operator="equal", formula=[f'"{value}"'], fill=fill, font=font))
        row += 1
        at_gen = {
            ReconciliationStatus.PASSED: STATUS_RECONCILED,
            ReconciliationStatus.FAILED: STATUS_NOT_RECONCILED,
            ReconciliationStatus.INCOMPLETE: STATUS_INCOMPLETE,
        }[rec.status]
        cell = label_value(row, "Status at generation", at_gen)
        cell.fill, cell.font = (_GREEN_FILL, _GREEN_FONT) if rec.passed else (_RED_FILL, _RED_FONT)
        row += 1
        cell = label_value(row, "Difference at generation", rec.difference, money=True)
        if not rec.passed:
            cell.fill, cell.font = _RED_FILL, _RED_FONT
            row += 1
            msg = (
                f"The statement does NOT reconcile: the stated closing balance differs from opening "
                f"balance + credits − debits by ₹{rec.difference:,}. No amounts have been adjusted."
                if rec.status is ReconciliationStatus.FAILED
                else "Some rows were rejected by validation, so the statement cannot be confirmed as "
                "reconciled. Review the rejected rows before relying on these totals."
            )
            cell = ws.cell(row=row, column=1, value=msg)
            cell.font, cell.fill, cell.alignment = _RED_FONT, _RED_FILL, _WRAP_TOP
            ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
            ws.row_dimensions[row].height = 32

    # Category totals.
    row += 2
    ws.cell(row=row, column=1, value="Totals by category (live from All Transactions)").font = _SECTION_FONT
    row += 1
    for c, name in enumerate(("Category", "Count", "Debit (₹)", "Credit (₹)", "Net (₹)"), start=1):
        cell = ws.cell(row=row, column=c, value=name)
        cell.font, cell.fill = _BOLD, _HEADER_FILL
    first_cat = row + 1
    for name in CANONICAL_CATEGORIES:
        row += 1
        ws.cell(row=row, column=1, value=name)
        ws.cell(row=row, column=2, value=f"=COUNTIF({all_cat},A{row})")
        _money(ws.cell(row=row, column=3, value=f"=SUMIFS({all_debit},{all_cat},A{row})"))
        _money(ws.cell(row=row, column=4, value=f"=SUMIFS({all_credit},{all_cat},A{row})"))
        _money(ws.cell(row=row, column=5, value=f"=D{row}-C{row}"))
    last_cat = row
    row += 1
    ws.cell(row=row, column=1, value="Total").font = _BOLD
    for c in range(2, 6):
        letter = get_column_letter(c)
        cell = ws.cell(row=row, column=c, value=f"=SUM({letter}{first_cat}:{letter}{last_cat})")
        cell.font, cell.border = _BOLD, _TOTAL_BORDER
        if c > 2:
            _money(cell)
    ws.cell(row=row, column=1).border = _TOTAL_BORDER
    refs.extra["category_total_row"] = str(row)
    row += 1
    check = ws.cell(row=row, column=1, value="Check: uncategorised or invalid category labels")
    check.font = Font(italic=True, color="57524A")
    ws.cell(row=row, column=2, value=f"=COUNTA({all_cat})-B{row - 1}")

    # Key figures.
    row += 2
    ws.cell(row=row, column=1, value="Key figures (as classified; not tax figures)").font = _SECTION_FONT
    key_figures = (
        ("Credits classified as Salary / Pension", Category.SALARY_PENSION, "credit"),
        ("Savings bank interest credited", Category.INTEREST_SAVINGS, "credit"),
        ("FD / RD / other interest credited", Category.INTEREST_DEPOSITS, "credit"),
        ("Dividends credited", Category.DIVIDEND, "credit"),
        ("Income tax refunds received", Category.INCOME_TAX_REFUND, "credit"),
        ("Payments classified as Tax Payments", Category.TAX_PAYMENTS, "debit"),
        ("Payments to tax-saving type instruments", Category.INVESTMENTS_TAX_SAVING, "debit"),
        ("Health insurance payments", Category.INSURANCE_HEALTH, "debit"),
        ("Loan EMI / repayments", Category.LOAN_EMI, "debit"),
        ("Cash withdrawals", Category.CASH_WITHDRAWAL, "debit"),
        ("Cash deposits", Category.CASH_DEPOSIT, "credit"),
        ("Credits still in Others – Needs Review", Category.OTHERS_NEEDS_REVIEW, "credit"),
        ("Debits still in Others – Needs Review", Category.OTHERS_NEEDS_REVIEW, "debit"),
    )
    for label, category, side in key_figures:
        row += 1
        rng = all_credit if side == "credit" else all_debit
        label_value(row, label, f'=SUMIFS({rng},{all_cat},"{category}")', money=True)
    row += 1
    status_rng = _ref(SHEET_ALL, COL["Review status"], 2, last)
    label_value(row, "Transactions not auto-classified (live)", f'=COUNTIF({status_rng},"<>{ReviewStatus.AUTO_CLASSIFIED}")-COUNTBLANK({status_rng})')
    row += 1
    large = sum(1 for t in txns if "large_credit" in t.flags)
    label_value(row, f"Unexplained credits ≥ ₹{config.large_credit_threshold:,} (at generation)", large)

    # Notes.
    row += 2
    ws.cell(row=row, column=1, value="Notes and assumptions").font = _SECTION_FONT
    notes = (
        "Amounts and narrations are reproduced exactly as extracted; nothing has been adjusted or rounded.",
        "Categories describe what each transaction appears to be from its narration. They are not "
        "conclusions on whether any amount is taxable, exempt or deductible.",
        "To reclassify, change the Category in 'All Transactions' (choose from the list). The totals, "
        "reconciliation and key figures above are live formulas and update automatically.",
        "Category sheets, 'Needs Review' and the 'at generation' values are a snapshot written when the "
        "workbook was generated; they do not move rows when categories are changed.",
        f"The large-credit review threshold (₹{config.large_credit_threshold:,}) and the reconciliation "
        f"tolerance (₹{config.reconciliation_tolerance}) are configurable settings, not legal thresholds.",
        "Recurring credits are flagged for confirmation but not assigned an income category.",
        "AIS / Form 26AS reconciliation appears only if those reports were supplied.",
    )
    for note in notes:
        row += 1
        cell = ws.cell(row=row, column=1, value=f"• {note}")
        cell.alignment = _WRAP_TOP
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
        ws.row_dimensions[row].height = 30

    # Disclaimer.
    row += 2
    ws.cell(row=row, column=1, value="Disclaimer").font = _SECTION_FONT
    row += 1
    cell = ws.cell(row=row, column=1, value=DISCLAIMER)
    cell.alignment = _WRAP_TOP
    cell.fill = _AMBER_FILL
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=6)
    ws.row_dimensions[row].height = 105
    refs.extra["disclaimer"] = cell.coordinate

    ws.freeze_panes = "A4"


def _find_label_row(ws: Worksheet, label: str) -> int:
    for (cell,) in ws.iter_rows(min_col=1, max_col=1):
        if cell.value == label:
            return cell.row
    raise KeyError(label)


def _write_ais(wb: Workbook, entries: list[SupportingReportEntry], last: int, tolerance_ref: str) -> None:
    ws = wb.create_sheet(SHEET_AIS)
    columns = (
        ("Source", 10), ("Information type", 36), ("Reported amount (₹)", 18), ("Bank category", 30),
        ("Bank amount (₹)", 18), ("Difference (₹)", 16), ("Status", 16), ("Remarks", 40),
    )
    _header(ws, 1, columns)
    all_cat = _ref(SHEET_ALL, COL["Category"], 2, last)
    tol = f"{quote_sheetname(SHEET_SUMMARY)}!{tolerance_ref}" if tolerance_ref else "0"
    for r, e in enumerate(entries, start=2):
        ws.cell(row=r, column=1, value=e.source)
        ws.cell(row=r, column=2, value=e.information_type)
        _money(ws.cell(row=r, column=3, value=e.reported_amount))
        ws.cell(row=r, column=8, value=e.remarks)
        if e.bank_category is None:
            ws.cell(row=r, column=4, value="Not mapped")
            ws.cell(row=r, column=7, value="Not compared")
            continue
        side = COL["Credit (₹)"] if e.direction is Direction.CREDIT else COL["Debit (₹)"]
        ws.cell(row=r, column=4, value=str(e.bank_category))
        _money(ws.cell(row=r, column=5, value=f"=SUMIFS({_ref(SHEET_ALL, side, 2, last)},{all_cat},D{r})"))
        _money(ws.cell(row=r, column=6, value=f"=C{r}-E{r}"))
        ws.cell(row=r, column=7, value=f'=IF(ABS(F{r})<={tol},"Matches","Difference")')
    status_range = f"G2:G{len(entries) + 1}"
    ws.conditional_formatting.add(status_range, CellIsRule(operator="equal", formula=['"Difference"'], fill=_RED_FILL, font=_RED_FONT))
    ws.conditional_formatting.add(status_range, CellIsRule(operator="equal", formula=['"Matches"'], fill=_GREEN_FILL, font=_GREEN_FONT))
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:H{len(entries) + 1}"


# --- public API ---------------------------------------------------------------

def build_workbook(
    report: ValidationReport,
    classified: list[Transaction],
    metadata: StatementMetadata,
    *,
    config: AnalysisConfig = DEFAULT_CONFIG,
    supporting_reports: list[SupportingReportEntry] | None = None,
) -> Workbook:
    """Build the internal workbook. `classified` must be the output of
    `classify_statement` for `report.transactions`."""
    valid_rows = {t.row_number for t in report.transactions}
    if {t.row_number for t in classified} != valid_rows or len(classified) != len(valid_rows):
        raise ValueError("classified transactions do not match the validated transactions")
    if any(t.matched_rule is None for t in classified):
        raise ValueError("transactions must be classified before building the workbook")

    txns = _ordered(list(classified))
    wb = Workbook()
    summary = wb.active
    summary.title = SHEET_SUMMARY

    list_ref = _write_lists(wb)
    last = _write_all_transactions(wb, txns, list_ref)

    taken = {SHEET_SUMMARY, SHEET_ALL, SHEET_LISTS}
    for name in CANONICAL_CATEGORIES:
        category = Category(name)
        rows = [t for t in txns if t.category is category]
        if rows:
            _write_category_sheet(wb, category, rows, taken)

    _write_needs_review(wb, txns)

    refs = _Refs()
    _write_summary(summary, report, txns, metadata, config, last, refs)

    if supporting_reports:
        _write_ais(wb, list(supporting_reports), last, refs.tolerance)

    # Keep the hidden list sheet last so visible tabs read in order.
    wb.move_sheet(SHEET_LISTS, offset=len(wb.sheetnames) - 1 - wb.sheetnames.index(SHEET_LISTS))
    wb.active = 0
    return wb


def save_workbook(wb: Workbook, path: str | Path) -> Path:
    path = Path(path)
    if any(part.lower() == "private" for part in path.resolve().parts):
        raise ValueError("refusing to write a workbook into a Private/ folder")
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    return path
