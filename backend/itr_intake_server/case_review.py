"""CA case review (Stage 5.8): turn one stored bank-statement upload into the
case's classified `statement_rows`.

Flow (`prepare_review`)
-----------------------
1. The upload must be a stored statement of this case and firm whose outcome
   was `extracted` or `manual_review_required`; the case must not be closed.
2. The stored file is re-read locally (CSV parser, or xpdf `pdftotext` for
   PDFs) with the current parser. Nothing leaves the machine.
3. The usable rows are validated (`validate_statement`) and classified
   (`classify_statement`, client name from the case profile).
4. In ONE transaction: the case's rows are replaced (valid rows with their
   classification; rows the parser rejected as invalid rows carrying only
   their reason codes), the case records the upload, period, balances,
   classifier version and time, and moves to `ca_review_required`. Any failure
   before or during that transaction leaves the previous rows untouched.

A review built from a `manual_review_required` upload, or one whose rows do
not all validate, or whose balance check does not pass, is reported as
`verified: false`. Nothing here logs narrations, amounts or file paths.
"""

import io
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path

from openpyxl.styles import Font, PatternFill

from itr_intake import statement_import as si
from itr_intake.categories import Category
from itr_intake.classifier import classify_statement
from itr_intake.config import DEFAULT_CONFIG, ClientProfile
from itr_intake.models import Confidence, ReviewStatus, Transaction, TransactionMode
from itr_intake.validation import (
    AmountError,
    Reconciliation,
    ReconciliationStatus,
    ValidationIssue,
    ValidationReport,
    parse_amount,
    parse_date,
    validate_statement,
)
from itr_intake.workbook import StatementMetadata, build_workbook

from . import repository as repo
from . import statements
from .db import utc_now
from .repository import FirmScope

CLASSIFIER_VERSION = "itr_intake.classifier/stage5.8"
PREPARABLE_UPLOAD_STATUSES = ("extracted", "manual_review_required")
# Case statuses a review may be prepared (or re-prepared) from; the result is always `ca_review_required`.
PREPARABLE_CASE_STATUSES = ("statement_uploaded", "ca_review_required", "review_ready")


class ReviewRefused(Exception):
    """The review cannot be prepared. `code` is a fixed, safe string."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class _Balances:
    opening: Decimal | None
    closing: Decimal | None


def _read_statement(path: Path, file_type: str, *, financial_year: str, pdftotext: str | None,
                    storage: statements.Storage) -> si.ImportResult:
    data = path.read_bytes()
    if file_type == "csv":
        return si.parse_csv(data, financial_year=financial_year)
    if pdftotext is None:
        raise ReviewRefused("pdf_extractor_unavailable")
    try:
        # The extractor's temporary text file goes in the private staging folder and is always deleted.
        pages = statements.extract_pdf_pages(pdftotext, path, storage.staging_dir())
    except statements.ExtractionFailed as exc:
        raise ReviewRefused(exc.code) from None
    return si.parse_pdf_pages(pages, financial_year=financial_year,
                              contains_images=statements._contains_images(data))


def _balances(rows: list) -> _Balances:
    """Opening and closing balances implied by the rows' own running balances,
    in date order; None when any usable row lacks a balance."""
    if not rows or any(r.balance is None for r in rows):
        return _Balances(None, None)
    try:
        parsed = [(parse_date(r.date, DEFAULT_CONFIG.date_formats), parse_amount(r.debit), parse_amount(r.credit),
                   parse_amount(r.balance, allow_negative=True)) for r in rows]
    except (AmountError, ValueError):
        return _Balances(None, None)
    if len(parsed) > 1 and parsed[0][0] > parsed[-1][0]:
        parsed.reverse()
    first, last = parsed[0], parsed[-1]
    return _Balances(first[3] - first[2] + first[1], last[3])


def prepare_review(conn, *, scope: FirmScope, case: dict, upload_id: object, actor_id: str,
                   storage: statements.Storage, pdftotext: str | None) -> dict:
    """Prepare (or re-prepare) the case's review from one stored upload.
    Returns the updated case. Raises repo.NotFound for an upload outside this
    case, ReviewRefused for every refused state, statements.ExtractorBusy when
    no PDF extraction slot frees up, and repo.Conflict("stale_version") if the
    case changed meanwhile."""
    if case["status"] == "closed":
        raise ReviewRefused("case_closed")
    if case["status"] not in PREPARABLE_CASE_STATUSES:
        raise ReviewRefused("invalid_case_status")
    upload = repo.get_statement_upload(conn, scope, case["id"], upload_id)  # NotFound outside the case
    if upload["status"] not in PREPARABLE_UPLOAD_STATUSES or upload["document_id"] is None:
        raise ReviewRefused("statement_not_usable")
    document = repo.get_document(conn, scope, case["id"], upload["document_id"])
    try:
        path = storage.path_for(document["storage_key"])
    except statements.StorageError:
        raise ReviewRefused("file_unavailable") from None
    if not path.is_file():
        raise ReviewRefused("file_missing")

    result = _read_statement(path, upload["file_type"], financial_year=case["financial_year"], pdftotext=pdftotext,
                             storage=storage)
    if result.status == si.REJECTED:
        raise ReviewRefused("statement_not_usable")

    profile = case.get("profile_json") or {}
    usable = list(result.transactions)
    balances = _balances(usable)
    report = validate_statement(usable, balances.opening if balances.opening is not None else "not available",
                                balances.closing if balances.closing is not None else "not available")
    classified = {t.row_number: t for t in classify_statement(report.transactions,
                                                              ClientProfile(name=profile.get("full_name")
                                                                            or case["client_first_name"]))}
    raw = {r.row_number: r for r in usable}
    issues = {}
    for issue in report.issues:
        if issue.row_number is not None:
            issues.setdefault(issue.row_number, []).append(issue.code)

    rows = []
    for r in result.rejected:
        rows.append({"row_number": r.row_number, "is_valid": False, "issues": list(r.codes)})
    for n, r in raw.items():
        t = classified.get(n)
        if t is None:  # failed project validation: kept as an invalid row with its codes only
            rows.append({"row_number": n, "is_valid": False, "issues": issues.get(n, ["invalid_row"]),
                         "raw_date": r.date, "raw_narration": r.narration, "raw_debit": r.debit,
                         "raw_credit": r.credit, "raw_balance": r.balance})
            continue
        rows.append({
            "row_number": n, "is_valid": True, "issues": issues.get(n, []), "flags": list(t.flags),
            "raw_date": r.date, "raw_narration": r.narration, "raw_debit": r.debit, "raw_credit": r.credit,
            "raw_balance": r.balance, "txn_date": t.date.isoformat(), "narration": t.narration,
            "debit": t.debit, "credit": t.credit, "balance": t.balance, "mode": t.mode.value,
            "counterparty": t.counterparty, "category": t.category.value, "confidence": t.confidence.value,
            "review_status": t.review_status.value, "matched_rule": t.matched_rule,
            "classification_reason": t.classification_reason, "classifier_version": CLASSIFIER_VERSION,
        })
    rows.sort(key=lambda row: row["row_number"])

    dates: list[date] = [t.date for t in report.transactions]
    with repo._atomic(conn):
        repo.replace_statement_rows(conn, scope, case["id"], rows)
        updated = repo.update_case(
            conn, scope, case["id"], expected_version=case["version"], status="ca_review_required",
            classifier_version=CLASSIFIER_VERSION, reviewed_upload_id=upload["id"], reviewed_at=utc_now(),
            period_start=min(dates).isoformat() if dates else None,
            period_end=max(dates).isoformat() if dates else None,
            opening_balance=balances.opening, closing_balance=balances.closing,
        )
        repo.record_audit_event(conn, actor_kind="ca", actor_id=actor_id, firm_id=scope.firm_id, case_id=case["id"],
                                action="case.review_prepared",
                                details={"upload_id": upload["id"], "rows": len(rows)})
    return updated


class NoReview(Exception):
    """The case has no prepared review to build a workbook from."""


_UNVERIFIED_TEXT = {
    "statement_needs_manual_review": "the statement needs manual review",
    "rows_invalid": "some rows could not be read",
    "balance_check_not_passed": "the running balance does not reconcile or could not be checked",
}


def build_case_workbook(conn, scope: FirmScope, case: dict) -> bytes:
    """The internal workbook (existing `build_workbook` format) for the case's
    stored review, built only from the stored rows and the case/upload
    metadata; the original file is not read. Raises NoReview when there is no
    review. The Summary sheet states whether the review is verified."""
    view = review_view(conn, scope, case)
    if view is None:
        raise NoReview()
    rows = repo.list_statement_rows(conn, scope, case["id"])
    txns, invalid = [], []
    for r in rows:
        if not r["is_valid"]:
            invalid.append(r)
            continue
        txns.append(Transaction(
            row_number=r["row_number"], date=date.fromisoformat(r["txn_date"]), narration=r["narration"],
            debit=Decimal(r["debit"]), credit=Decimal(r["credit"]),
            balance=Decimal(r["balance"]) if r["balance"] is not None else None,
            raw_debit=r["raw_debit"], raw_credit=r["raw_credit"], raw_balance=r["raw_balance"],
            mode=TransactionMode(r["mode"]), counterparty=r["counterparty"], category=Category(r["category"]),
            classification_reason=r["classification_reason"] or "", confidence=Confidence(r["confidence"]),
            review_status=ReviewStatus(r["review_status"]), matched_rule=r["matched_rule"],
            flags=tuple(r["flags_json"]),
        ))

    rec = view["reconciliation"]
    reconciliation = None
    if rec["status"] != "not_available":
        reconciliation = Reconciliation(
            opening_balance=Decimal(rec["opening_balance"]), total_credits=Decimal(view["totals"]["credits"]),
            total_debits=Decimal(view["totals"]["debits"]), expected_closing_balance=Decimal(rec["expected_closing"]),
            stated_closing_balance=Decimal(rec["stated_closing"]), difference=Decimal(rec["difference"]),
            tolerance=DEFAULT_CONFIG.reconciliation_tolerance, status=ReconciliationStatus(rec["status"]))
    report = ValidationReport(
        rows_received=len(rows), transactions=tuple(txns),
        issues=tuple(ValidationIssue(r["row_number"], "row", code, code) for r in invalid for code in r["issues_json"]),
        reconciliation=reconciliation, credit_count=sum(1 for t in txns if t.credit > 0),
        debit_count=sum(1 for t in txns if t.debit > 0), invalid_row_numbers=tuple(r["row_number"] for r in invalid))

    statement = view["statement"]
    note = (f"Review of uploaded {statement['file_type'].upper()} statement '{statement['display_name']}', "
            f"prepared {view['prepared_at'][:16].replace('T', ' ')} UTC.")
    if invalid:
        listed = ", ".join(f"{r['row_number']} ({'/'.join(r['issues_json'])})" for r in invalid[:30])
        note += f" Rows not read: {listed}{' and more' if len(invalid) > 30 else ''}."
    profile = case.get("profile_json") or {}
    metadata = StatementMetadata(
        client_name=profile.get("full_name") or case["client_first_name"], client_reference=case["reference"],
        bank_name=profile.get("bank_name"), account_number=profile.get("account_last4"),
        financial_year=case["financial_year"],
        period_start=date.fromisoformat(case["period_start"]) if case["period_start"] else None,
        period_end=date.fromisoformat(case["period_end"]) if case["period_end"] else None,
        data_source_note=note)
    wb = build_workbook(report, txns, metadata)

    # Verification line under the builder's INTERNAL banner (row 3 is empty in its layout).
    summary = wb.worksheets[0]
    if view["verified"]:
        text = "Verified extraction: every row was read and the running balance reconciles."
        fill, font = PatternFill("solid", fgColor="DDEFE9"), Font(bold=True, color="1F5F55")
    else:
        reasons = "; ".join(_UNVERIFIED_TEXT.get(r, r) for r in view["unverified_reasons"])
        text = f"UNVERIFIED REVIEW - do not rely on these figures without checking the statement: {reasons}."
        fill, font = PatternFill("solid", fgColor="F8D7DA"), Font(bold=True, color="9B1C2C")
    cell = summary.cell(row=3, column=1, value=text)
    cell.data_type = "s"
    cell.fill, cell.font = fill, font
    summary.merge_cells("A3:F3")

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _verification(case: dict, upload: dict, rows: list[dict]) -> dict:
    """The stored review's totals, balance check and verified flag, from the
    persisted rows (only `is_valid`, `debit` and `credit` are read). Shared by
    the case detail and the dashboard so both apply the same rule."""
    valid = [r for r in rows if r["is_valid"]]
    credits = sum((Decimal(r["credit"]) for r in valid), Decimal("0"))
    debits = sum((Decimal(r["debit"]) for r in valid), Decimal("0"))
    opening = Decimal(case["opening_balance"]) if case["opening_balance"] is not None else None
    closing = Decimal(case["closing_balance"]) if case["closing_balance"] is not None else None
    invalid = len(rows) - len(valid)
    if opening is None or closing is None:
        reconciliation = {"status": "not_available"}
    else:
        expected = opening + credits - debits
        difference = closing - expected
        status = ("incomplete" if invalid else
                  "passed" if abs(difference) <= DEFAULT_CONFIG.reconciliation_tolerance else "failed")
        reconciliation = {"status": status, "opening_balance": str(opening), "expected_closing": str(expected),
                          "stated_closing": str(closing), "difference": str(difference)}
    return {
        "valid": valid, "invalid": invalid, "credits": credits, "debits": debits, "reconciliation": reconciliation,
        "verified": upload["status"] == "extracted" and invalid == 0 and reconciliation["status"] == "passed",
        "unverified_reasons": [reason for reason, applies in (
            ("statement_needs_manual_review", upload["status"] != "extracted"),
            ("rows_invalid", invalid > 0),
            ("balance_check_not_passed", reconciliation["status"] != "passed"),
        ) if applies],
    }


def review_view(conn, scope: FirmScope, case: dict) -> dict | None:
    """The stored review of a case for its own firm's CA, or None."""
    if not case.get("reviewed_upload_id"):
        return None
    upload = repo.get_statement_upload(conn, scope, case["id"], case["reviewed_upload_id"])
    rows = repo.list_statement_rows(conn, scope, case["id"])
    check = _verification(case, upload, rows)
    valid, invalid, credits, debits = check["valid"], check["invalid"], check["credits"], check["debits"]
    reconciliation, verified = check["reconciliation"], check["verified"]
    return {
        "statement": statements.upload_view(upload),
        "prepared_at": case["reviewed_at"],
        "classifier_version": case["classifier_version"],
        "period_start": case["period_start"],
        "period_end": case["period_end"],
        "verified": verified,
        "unverified_reasons": check["unverified_reasons"],
        "totals": {"rows": len(rows), "valid": len(valid), "invalid": invalid,
                   "needs_review": sum(1 for r in valid if r["review_status"] != "Auto-classified"),
                   "credits": str(credits), "debits": str(debits)},
        "reconciliation": reconciliation,
        "rows": [{
            "row_number": r["row_number"], "is_valid": bool(r["is_valid"]), "issues": r["issues_json"],
            "date": r["txn_date"], "narration": r["narration"], "debit": r["debit"], "credit": r["credit"],
            "balance": r["balance"], "category": r["category"], "confidence": r["confidence"],
            "review_status": r["review_status"], "flags": r["flags_json"],
            "classification_reason": r["classification_reason"],
        } for r in rows],
    }


def readiness_view(conn, scope: FirmScope, case: dict) -> dict:
    """Rule-based readiness facts for the CA dashboard. Read-only: it reads the
    persisted review (upload status, case balances, row amounts) and request
    statuses, and never parses, classifies or writes anything.
    `statement` is one of: none (nothing usable uploaded), not_prepared (a
    usable upload exists but no review was prepared), unverified, verified.
    Document counts cover required requests only. No judgement about tax or
    legal completeness is made here."""
    uploads = repo.list_case_statement_uploads(conn, scope, case["id"])
    usable = [u for u in uploads if u["status"] in PREPARABLE_UPLOAD_STATUSES]
    if case.get("reviewed_upload_id"):
        upload = repo.get_statement_upload(conn, scope, case["id"], case["reviewed_upload_id"])
        check = _verification(case, upload, repo.list_statement_row_amounts(conn, scope, case["id"]))
        statement, reasons = ("verified" if check["verified"] else "unverified"), check["unverified_reasons"]
    else:
        statement, reasons = ("not_prepared" if usable else "none"), []
    requests = repo.list_document_requests(conn, scope, case["id"])
    required = [r for r in requests if r["required"]]
    return {
        "statement": statement,
        "unverified_reasons": reasons,
        "documents": {
            "required_outstanding": sum(1 for r in required if r["status"] == "requested"),
            "required_received": sum(1 for r in required if r["status"] == "received"),
            "required_waived": sum(1 for r in required if r["status"] == "waived"),
            "optional_outstanding": sum(1 for r in requests if not r["required"] and r["status"] == "requested"),
            "total_requests": len(requests),
        },
    }
