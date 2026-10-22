"""Turn an uploaded bank statement (CSV text, or PDF page text) into
`RawTransaction` rows and decide, conservatively, whether the extraction can
be trusted.

Pure functions only: no files, subprocesses or database. The server layer
reads the file and runs the PDF text extractor; this module parses text.

Outcomes
--------
- `extracted`: every check below passed.
- `manual_review_required`: something was usable but could not be confirmed
  (rejected rows, duplicate-looking rows, pages without extractable text, an
  unrecognised layout, a broken balance chain, dates outside the financial
  year, ...). Partial results are kept but never presented as complete.
- `rejected`: the file itself is unusable (wrong encoding, malformed CSV,
  missing required columns, no data, too large). The server also rejects at
  the file level (signatures, size, type mismatch).

Nothing here guesses: a missing date, narration or amount is never filled in,
an amount is only read from the column it is under, and rows are never
dropped silently (each rejected row is reported by row number and reason
codes, never by its contents).

Supported CSV schema (documented in HANDOFF.md)
----------------------------------------------
UTF-8 (a BOM is allowed), comma-delimited, RFC 4180 quoting. An optional
preamble of up to 20 lines may precede the header row. Header names are
matched case-insensitively after trimming:
  date (required):      Date, Txn Date, Tran Date, Transaction Date, Value Date, Post Date
  narration (required): Narration, Description, Particulars, Details, Remarks, Transaction Details
  debit:                Debit, Withdrawal(s), Withdrawal Amt/Amount, Debit Amount, Dr
  credit:               Credit, Deposit(s), Deposit Amt/Amount, Credit Amount, Cr
  balance (optional):   Balance, Closing Balance, Balance Amount, Running Balance
At least one of debit/credit is required. Dates are day-first only, in the
project's `AnalysisConfig.date_formats`. Amounts: plain or Indian/Western
grouped digits with at most two decimals, optional "₹"/"INR"; debit and
credit must not be negative; a balance may end in "Cr"/"Dr" ("Dr" = negative).

Supported PDF layout
--------------------
Text-based PDFs whose page text (xpdf `pdftotext -simple`) contains a header
line naming a date column, and at least two of withdrawal/debit,
deposit/credit and balance columns. Transaction lines start with a date;
amounts carry exactly two decimals. Each amount column owns the band from its
header label's start to the next amount label's start (labels may be left-
aligned, centred or right-aligned); an amount belongs to the band holding its
last character, and one touching a band boundary or spanning a whole column is
ambiguous and its row rejected. A header is used only on its own page: dated
lines on a page without a header are rejected (`no_header_on_page`), because
page text positions can shift between pages. Wrapped narration lines are joined to the
row above. Opening/closing/brought-forward/carried-forward/total lines are
recognised as summaries, not transactions. A single signed "Amount" column or
a separate Dr/Cr indicator column is not supported (manual review).
"""

import csv
import io
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from .config import DEFAULT_CONFIG, AnalysisConfig
from .models import RawTransaction
from .validation import AmountError, parse_amount, parse_date, validate_statement

EXTRACTED = "extracted"
MANUAL_REVIEW = "manual_review_required"
REJECTED = "rejected"

MAX_CSV_ROWS = 10_000
MAX_CSV_COLUMNS = 40
MAX_FIELD_CHARS = 1_000
MAX_PREAMBLE_LINES = 20
MAX_PDF_TRANSACTIONS = 10_000
MIN_PAGE_TEXT_CHARS = 30  # fewer non-space characters than this: treat the page as having no text

_HEADER_SYNONYMS = {
    "date": ("date", "txn date", "tran date", "transaction date", "value date", "post date", "posting date"),
    "narration": ("narration", "description", "particulars", "details", "remarks", "transaction details",
                  "transaction remarks"),
    "debit": ("debit", "debits", "withdrawal", "withdrawals", "withdrawal amt", "withdrawal amt.",
              "withdrawal amount", "debit amount", "dr", "debit amt"),
    "credit": ("credit", "credits", "deposit", "deposits", "deposit amt", "deposit amt.", "deposit amount",
               "credit amount", "cr", "credit amt"),
    "balance": ("balance", "closing balance", "balance amount", "running balance", "balance amt"),
}

# Text that may start a spreadsheet formula when exported.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def neutralise_formula(text: str) -> str:
    """Text safe to place in a spreadsheet cell: a leading formula character
    is escaped with an apostrophe. (The workbook generator already writes
    narrations as literal strings; this is for any other export.)"""
    return "'" + text if text.startswith(_FORMULA_PREFIXES) else text


@dataclass(frozen=True)
class RowRejection:
    row_number: int
    codes: tuple[str, ...]
    page: int | None = None


@dataclass(frozen=True)
class PageWarning:
    page: int
    code: str


@dataclass(frozen=True)
class ImportResult:
    file_type: str
    status: str
    transactions: tuple[RawTransaction, ...] = ()
    rejected: tuple[RowRejection, ...] = ()
    duplicate_rows: tuple[int, ...] = ()
    review_reasons: tuple[str, ...] = ()
    page_warnings: tuple[PageWarning, ...] = ()
    pages_total: int | None = None
    summary_rows: int = 0
    error_code: str | None = None
    period_start: date | None = None
    period_end: date | None = None
    row_pages: dict[int, int] = field(default_factory=dict)

    def __repr__(self) -> str:  # counts only; never transaction contents
        return (f"ImportResult({self.file_type}, {self.status}, extracted={len(self.transactions)}, "
                f"rejected={len(self.rejected)}, duplicates={len(self.duplicate_rows)})")


def _rejected_file(file_type: str, code: str) -> ImportResult:
    return ImportResult(file_type, REJECTED, error_code=code)


def _norm_header(cell: str) -> str:
    return re.sub(r"\s+", " ", cell.strip().strip("﻿").lower().replace("_", " ")).strip(" :.")


def _fy_bounds(financial_year: str | None) -> tuple[date, date] | None:
    if not financial_year or not re.fullmatch(r"\d{4}-\d{2}", financial_year):
        return None
    start = int(financial_year[:4])
    return date(start, 4, 1), date(start + 1, 3, 31)


# --- shared row validation -------------------------------------------------------------------------


def _clean_amount_text(raw: str | None, *, balance: bool) -> tuple[str | None, str | None]:
    """Normalise an amount cell for `parse_amount`: strip currency marks and,
    for balances only, a trailing Cr/Dr. Returns (text, error_code)."""
    if raw is None:
        return None, None
    text = raw.strip()
    if text in ("", "-", "--"):
        return None, None
    text = re.sub(r"^(?:₹|INR|Rs\.?)\s*", "", text, flags=re.IGNORECASE)
    sign = ""
    if balance:
        m = re.fullmatch(r"(.*?)\s*(Cr|CR|cr|Dr|DR|dr)\.?", text)
        if m:
            text, sign = m.group(1).strip(), ("-" if m.group(2).lower() == "dr" else "")
    if text.startswith("(") and text.endswith(")"):
        return None, "negative_amount"
    if not re.fullmatch(r"-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?", text):
        return None, "invalid_amount"
    if sign == "-":
        if text.startswith("-"):
            return None, "invalid_amount"
        text = "-" + text
    return text, None


def _finish(file_type: str, rows: list[RawTransaction], pre_rejected: dict[int, list[str]], *,
            config: AnalysisConfig, financial_year: str | None, review: list[str],
            page_warnings: list[PageWarning], pages_total: int | None, summary_rows: int,
            row_pages: dict[int, int], require_balance_chain: bool, opening_hint: str | None = None
            ) -> ImportResult:
    """Validate candidate rows with the project's `validate_statement`, then
    apply duplicate, period and balance-chain checks."""
    rejected: dict[int, list[str]] = {n: list(c) for n, c in pre_rejected.items()}
    candidates = [r for r in rows if r.row_number not in rejected]

    report = validate_statement(candidates, "0", "0", config)
    for issue in report.errors:
        if issue.row_number is not None:
            rejected.setdefault(issue.row_number, []).append(issue.code)
    valid = [r for r in candidates if r.row_number not in rejected]
    txns = {t.row_number: t for t in report.transactions}

    # Dates outside the case's financial year (kept, but flagged).
    bounds = _fy_bounds(financial_year)
    if bounds and any(not (bounds[0] <= txns[r.row_number].date <= bounds[1]) for r in valid):
        review.append("dates_outside_financial_year")

    # Duplicate-looking rows: identical date, narration and amounts, and no
    # different running balance to tell them apart. They are kept and flagged.
    keys = Counter((r.date, r.narration, r.debit, r.credit, r.balance) for r in valid)
    duplicates = tuple(r.row_number for r in valid if keys[(r.date, r.narration, r.debit, r.credit, r.balance)] > 1)
    if duplicates:
        review.append("duplicate_looking_rows")

    # Balance chain: every row's stated balance must follow from the previous one.
    has_balances = bool(valid) and all(txns[r.row_number].balance is not None for r in valid)
    if valid and not has_balances:
        if any(txns[r.row_number].balance is not None for r in valid):
            review.append("balance_missing_on_rows")
        elif require_balance_chain:  # a PDF without balances cannot be shown to be complete
            review.append("balance_column_missing")
    if valid and has_balances and not rejected:
        ordered = [txns[r.row_number] for r in valid]
        if len(ordered) > 1 and ordered[0].date > ordered[-1].date:
            ordered.reverse()  # newest-first statements
        first = ordered[0]
        opening = first.balance - first.credit + first.debit
        if opening_hint is not None:
            hint, err = _clean_amount_text(opening_hint, balance=True)
            if err is None and hint is not None and parse_amount(hint, allow_negative=True) != opening:
                review.append("opening_balance_mismatch")
        chain = validate_statement([RawTransaction(t.row_number, t.date.strftime("%d/%m/%Y"), t.narration,
                                                   str(t.debit), str(t.credit), str(t.balance)) for t in ordered],
                                   opening, ordered[-1].balance, config)
        if any(i.code == "running_balance_mismatch" for i in chain.issues):
            review.append("balance_chain_broken")
    elif require_balance_chain and valid and rejected:
        review.append("balance_chain_not_verifiable")

    if rejected:
        review.append("rows_rejected")
    if not valid:
        review.append("no_transactions_found")

    dates = [txns[r.row_number].date for r in valid]
    status = MANUAL_REVIEW if (review or page_warnings or rejected) else EXTRACTED
    return ImportResult(
        file_type=file_type, status=status, transactions=tuple(valid),
        rejected=tuple(RowRejection(n, tuple(dict.fromkeys(c)), row_pages.get(n)) for n, c in sorted(rejected.items())),
        duplicate_rows=duplicates, review_reasons=tuple(dict.fromkeys(review)), page_warnings=tuple(page_warnings),
        pages_total=pages_total, summary_rows=summary_rows, period_start=min(dates) if dates else None,
        period_end=max(dates) if dates else None, row_pages=row_pages,
    )


# --- CSV ----------------------------------------------------------------------------------------------


def _match_columns(header: list[str]) -> dict[str, int] | None:
    found: dict[str, int] = {}
    names = [_norm_header(h) for h in header]
    for key, synonyms in _HEADER_SYNONYMS.items():
        # Prefer the earliest synonym in the list (e.g. "date"/"txn date" before "value date").
        for synonym in synonyms:
            if synonym in names and key not in found:
                found[key] = names.index(synonym)
    if "date" in found and "narration" in found and ("debit" in found or "credit" in found):
        return found
    return None


def parse_csv(data: bytes, *, financial_year: str | None = None, config: AnalysisConfig = DEFAULT_CONFIG,
              ) -> ImportResult:
    if not data.strip():
        return _rejected_file("csv", "empty_file")
    if b"\x00" in data:
        return _rejected_file("csv", "unsupported_encoding")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return _rejected_file("csv", "unsupported_encoding")

    csv.field_size_limit(MAX_FIELD_CHARS * 10)
    try:
        records = []
        for i, record in enumerate(csv.reader(io.StringIO(text, newline=""), strict=True)):
            if i > MAX_CSV_ROWS + MAX_PREAMBLE_LINES:
                return _rejected_file("csv", "too_many_rows")
            if len(record) > MAX_CSV_COLUMNS:
                return _rejected_file("csv", "too_many_columns")
            records.append(record)
    except csv.Error:
        return _rejected_file("csv", "malformed_csv")

    header_index, columns = None, None
    for i, record in enumerate(records[: MAX_PREAMBLE_LINES + 1]):
        columns = _match_columns(record)
        if columns:
            header_index = i
            break
    if header_index is None:
        first = next((r for r in records if any(c.strip() for c in r)), [])
        if len(first) == 1 and (";" in first[0] or "\t" in first[0]):
            return _rejected_file("csv", "unsupported_delimiter")
        return _rejected_file("csv", "missing_required_columns")
    assert columns is not None
    width = len(records[header_index])
    body = records[header_index + 1:]
    if not any(any(c.strip() for c in r) for r in body):
        return _rejected_file("csv", "no_data_rows")

    rows: list[RawTransaction] = []
    pre_rejected: dict[int, list[str]] = {}
    summary_rows = 0
    row_number = 0
    for record in body:
        if not any(c.strip() for c in record):
            continue  # blank line between rows; not a transaction
        row_number += 1
        if len(record) != width:
            pre_rejected[row_number] = ["column_count_mismatch"]
            continue
        if any(len(c) > MAX_FIELD_CHARS for c in record):
            pre_rejected[row_number] = ["field_too_long"]
            continue

        def cell(key: str) -> str | None:
            idx = columns.get(key)
            value = record[idx].strip() if idx is not None else ""
            return value or None

        raw_date, narration = cell("date"), cell("narration")
        if raw_date is None and narration and re.search(
                r"\b(opening|closing|total|balance b/?f|brought forward|carried forward)\b", narration, re.IGNORECASE):
            summary_rows += 1
            continue
        codes: list[str] = []
        debit, err_d = _clean_amount_text(cell("debit"), balance=False)
        credit, err_c = _clean_amount_text(cell("credit"), balance=False)
        balance, err_b = _clean_amount_text(cell("balance"), balance=True)
        for err, name in ((err_d, "debit"), (err_c, "credit"), (err_b, "balance")):
            if err:
                codes.append(f"{name}_{err}")
        if raw_date is not None:
            try:
                parse_date(raw_date, config.date_formats)
            except ValueError:
                codes.append("invalid_date")
        if codes:
            pre_rejected[row_number] = codes
            continue
        rows.append(RawTransaction(row_number, raw_date, narration, debit, credit, balance))

    if row_number > MAX_CSV_ROWS:
        return _rejected_file("csv", "too_many_rows")
    return _finish("csv", rows, pre_rejected, config=config, financial_year=financial_year, review=[],
                   page_warnings=[], pages_total=None, summary_rows=summary_rows, row_pages={},
                   require_balance_chain=False)


# --- PDF page text ------------------------------------------------------------------------------------

_DATE_TOKEN = re.compile(
    r"\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4}")
_AMOUNT_TOKEN = re.compile(
    r"(?<![\w/.,-])(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}(?:\s?(?:Cr|CR|Dr|DR)\b)?(?![\w/.,])")
_SUMMARY = re.compile(r"\b(opening\s+balance|closing\s+balance|balance\s+b/?f|balance\s+c/?f|b/f|c/f|"
                      r"brought\s+forward|carried\s+forward|sub\s*total|grand\s+total|total)\b", re.IGNORECASE)
_OPENING = re.compile(r"\b(opening\s+balance|balance\s+b/?f|b/f|brought\s+forward)\b", re.IGNORECASE)
_FOOTER = re.compile(r"\b(page\s+\d+|computer\s+generated|end\s+of\s+statement|abbreviation|legend|"
                     r"this\s+is\s+a|registered\s+office|customer\s+care|toll\s+free)\b", re.IGNORECASE)


@dataclass
class _Header:
    spans: dict[str, tuple[int, int]]  # column key -> (start, end) character positions

    @property
    def amount_start(self) -> int:
        return min(self.spans[k][0] for k in ("debit", "credit", "balance") if k in self.spans)


def _find_header(line: str) -> _Header | None:
    lowered = line.lower()
    spans: dict[str, tuple[int, int]] = {}
    # Longest synonyms first so "withdrawal amt" wins over "withdrawal".
    for key, synonyms in _HEADER_SYNONYMS.items():
        for synonym in sorted(synonyms, key=len, reverse=True):
            if len(synonym) <= 2:
                continue  # "dr"/"cr" alone are too ambiguous in free text
            m = re.search(rf"(?<![a-z]){re.escape(synonym)}(?![a-z])", lowered)
            if m and key not in spans:
                spans[key] = (m.start(), m.end())
    amount_cols = sum(1 for k in ("debit", "credit", "balance") if k in spans)
    if "date" in spans and amount_cols >= 2 and ("debit" in spans or "credit" in spans):
        # A bare "date" inside another column label (e.g. "value date" after "date") is fine; keep the first.
        return _Header(spans)
    return None


def _assign(token_start: int, token_end: int, header: _Header) -> str | None:
    """The amount column a token belongs to, using start-anchored bands.

    Each amount column owns the band from its header label's first character
    up to (not including) the next amount label's first character; the last
    column's band runs to the end of the line. A token belongs to the band that
    holds its last character. It is ambiguous (None), never given to a nearby
    column, when its last character falls before the first amount label, when
    it ends right against the next label (touching the boundary), or when it
    reaches back past the previous column's label. Labels may be left-aligned,
    centred or right-aligned over their amounts; the balance chain later
    checks every assignment."""
    cols = sorted((header.spans[k][0], k) for k in ("debit", "credit", "balance") if k in header.spans)
    last = token_end - 1  # index of the token's final character
    for i, (band_start, key) in enumerate(cols):
        band_end = cols[i + 1][0] if i + 1 < len(cols) else None
        if last < band_start or (band_end is not None and last >= band_end):
            continue
        if band_end is not None and token_end >= band_end:
            return None  # ends against the next column's label
        if i > 0 and token_start < cols[i - 1][0]:
            return None  # spans the whole previous column
        return key
    return None


def parse_pdf_pages(pages: list[str], *, financial_year: str | None = None, contains_images: bool = False,
                    config: AnalysisConfig = DEFAULT_CONFIG) -> ImportResult:
    """Parse per-page text (as produced by `pdftotext -simple`)."""
    pages_total = len(pages)
    if pages_total == 0:
        return _rejected_file("pdf", "no_pages")

    pending: list[dict] = []
    pre_rejected: dict[int, list[str]] = {}
    row_pages: dict[int, int] = {}
    warnings: list[PageWarning] = []
    review: list[str] = []
    summary_rows = 0
    opening_hint: str | None = None
    seen_header = False
    row_number = 0

    for page_no, text in enumerate(pages, start=1):
        if sum(1 for ch in text if not ch.isspace()) < MIN_PAGE_TEXT_CHARS:
            warnings.append(PageWarning(page_no, "no_extractable_text"))
            continue
        page_rows = 0
        open_row: dict | None = None
        # A header is trusted only on the page where it appears: `pdftotext
        # -simple` positions text relative to each page, so another page's
        # column positions can be shifted.
        header: _Header | None = None
        for line in text.splitlines():
            if not line.strip():
                continue
            found = _find_header(line)
            if found:
                header, open_row, seen_header = found, None, True
                continue
            if header is None:
                stripped = line.lstrip()
                if seen_header and _DATE_TOKEN.match(stripped) and len(line) - len(stripped) <= 12:
                    # A transaction-like line on a page without its own header: counted, never read.
                    row_number += 1
                    if row_number > MAX_PDF_TRANSACTIONS:
                        return _rejected_file("pdf", "too_many_rows")
                    row_pages[row_number] = page_no
                    page_rows += 1
                    pre_rejected[row_number] = ["no_header_on_page"]
                continue  # statement heading text, or a page without a header
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            zone = header.amount_start - 8  # amounts left of this belong to the narration text
            amounts = [(m.start(), m.end(), m.group(0)) for m in _AMOUNT_TOKEN.finditer(line) if m.start() >= zone]
            date_match = _DATE_TOKEN.match(stripped)

            if date_match and indent <= header.spans["date"][1] + 2:
                row_number += 1
                if row_number > MAX_PDF_TRANSACTIONS:
                    return _rejected_file("pdf", "too_many_rows")
                row_pages[row_number] = page_no
                page_rows += 1
                columns: dict[str, str] = {}
                ambiguous = False
                for start, end, token in amounts:
                    column = _assign(start, end, header)
                    if column is None or column in columns:
                        ambiguous = True
                        break
                    columns[column] = token
                first_amount = min((s for s, _, _ in amounts), default=len(line))
                narration = line[indent + date_match.end():first_amount].strip()
                # A second date right after the first (value date + posting date) is not narration.
                narration = re.sub(rf"^(?:{_DATE_TOKEN.pattern})\s*", "", narration).strip() or None
                if ambiguous:
                    pre_rejected[row_number] = ["ambiguous_columns"]
                    open_row = None
                    continue
                open_row = {"n": row_number, "date": date_match.group(0), "narration": narration,
                            "debit": columns.get("debit"), "credit": columns.get("credit"),
                            "balance": columns.get("balance")}
                pending.append(open_row)
                continue

            if amounts:
                if _SUMMARY.search(line):
                    summary_rows += 1
                    if _OPENING.search(line) and opening_hint is None and not pending:
                        opening_hint = amounts[-1][2]
                else:
                    warnings.append(PageWarning(page_no, "unrecognised_amount_line"))
                open_row = None
                continue

            narration_start = header.spans.get("narration", (header.spans["date"][1], 0))[0]
            if (open_row is not None and indent >= narration_start - 2 and len(line.rstrip()) <= zone
                    and not _FOOTER.search(line) and not _SUMMARY.search(line)):
                open_row["narration"] = f"{open_row['narration'] or ''} {stripped.strip()}".strip()
            else:
                open_row = None  # footer or other text: never part of a transaction
        if header is None and page_rows:
            warnings.append(PageWarning(page_no, "no_header_on_page"))
        elif not page_rows:
            warnings.append(PageWarning(page_no, "no_transaction_table" if header is None
                                        else "no_transactions_on_page"))

    raw_rows = [RawTransaction(r["n"], r["date"], r["narration"], r["debit"], r["credit"], r["balance"])
                for r in pending]
    cleaned: list[RawTransaction] = []
    for r in raw_rows:
        codes = []
        debit, e1 = _clean_amount_text(r.debit, balance=False)
        credit, e2 = _clean_amount_text(r.credit, balance=False)
        balance, e3 = _clean_amount_text(r.balance, balance=True)
        for err, name in ((e1, "debit"), (e2, "credit"), (e3, "balance")):
            if err:
                codes.append(f"{name}_{err}")
        try:
            parse_date(r.date or "", config.date_formats)
        except ValueError:
            codes.append("invalid_date")
        if codes:
            pre_rejected[r.row_number] = codes
        else:
            cleaned.append(RawTransaction(r.row_number, r.date, r.narration, debit, credit, balance))

    if not seen_header:
        review.append("unsupported_layout")
    if contains_images and any(w.code in ("no_extractable_text", "no_header_on_page", "no_transaction_table")
                               for w in warnings):
        review.append("image_content_not_extracted")
    if any(w.code == "unrecognised_amount_line" for w in warnings):
        review.append("unrecognised_lines")
    if any(w.code == "no_extractable_text" for w in warnings):
        review.append("pages_without_text")
    return _finish("pdf", cleaned, pre_rejected, config=config, financial_year=financial_year, review=review,
                   page_warnings=warnings, pages_total=pages_total, summary_rows=summary_rows,
                   row_pages=row_pages, require_balance_chain=True, opening_hint=opening_hint)
