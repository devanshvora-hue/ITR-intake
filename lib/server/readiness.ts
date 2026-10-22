// Review verification and dashboard readiness (ported from case_review.py
// `_verification` and `readiness_view`). Read-only: stored upload status, case
// balances, row amounts and request statuses. It never parses, classifies or
// writes, and it makes no judgement about tax or legal completeness.

import type { Db } from "./db";
import { formatPaise, parseAmount, RECONCILIATION_TOLERANCE } from "../statement/validation";

export const PREPARABLE_UPLOAD_STATUSES = ["extracted", "manual_review_required"];

type CaseBalances = { opening_balance: string | null; closing_balance: string | null };
type AmountRow = { is_valid: boolean; debit: string | null; credit: string | null };

export function verification(caseRow: CaseBalances, uploadStatus: string, rows: AmountRow[]) {
  const valid = rows.filter((r) => r.is_valid);
  const credits = valid.reduce((sum, r) => sum + parseAmount(r.credit), 0n);
  const debits = valid.reduce((sum, r) => sum + parseAmount(r.debit), 0n);
  const invalid = rows.length - valid.length;
  let reconciliation: Record<string, string>;
  if (caseRow.opening_balance === null || caseRow.closing_balance === null) {
    reconciliation = { status: "not_available" };
  } else {
    const opening = parseAmount(caseRow.opening_balance, true);
    const closing = parseAmount(caseRow.closing_balance, true);
    const expected = opening + credits - debits;
    const difference = closing - expected;
    const abs = difference < 0n ? -difference : difference;
    reconciliation = {
      status: invalid ? "incomplete" : abs <= RECONCILIATION_TOLERANCE ? "passed" : "failed",
      opening_balance: formatPaise(opening), expected_closing: formatPaise(expected),
      stated_closing: formatPaise(closing), difference: formatPaise(difference),
    };
  }
  const unverifiedReasons = ([
    ["statement_needs_manual_review", uploadStatus !== "extracted"],
    ["rows_invalid", invalid > 0],
    ["balance_check_not_passed", reconciliation.status !== "passed"],
  ] as const).filter(([, applies]) => applies).map(([reason]) => reason);
  return {
    validCount: valid.length, invalid, credits, debits, reconciliation,
    verified: unverifiedReasons.length === 0, unverifiedReasons,
  };
}

export async function readinessView(db: Db, firmId: string, caseRow: CaseBalances & { id: string; reviewed_upload_id: string | null }) {
  const uploads = await db.query<{ id: string; status: string }>(
    "SELECT id, status FROM statement_uploads WHERE case_id = $1 AND firm_id = $2", [caseRow.id, firmId]);
  let statement: string;
  let reasons: string[] = [];
  const reviewed = caseRow.reviewed_upload_id ? uploads.find((u) => u.id === caseRow.reviewed_upload_id) : undefined;
  if (reviewed) {
    const rows = await db.query<AmountRow>(
      "SELECT is_valid, debit::text AS debit, credit::text AS credit FROM statement_rows WHERE case_id = $1 AND firm_id = $2",
      [caseRow.id, firmId]);
    const check = verification(caseRow, reviewed.status, rows);
    statement = check.verified ? "verified" : "unverified";
    reasons = check.unverifiedReasons;
  } else {
    statement = uploads.some((u) => PREPARABLE_UPLOAD_STATUSES.includes(u.status)) ? "not_prepared" : "none";
  }
  const requests = await db.query<{ required: boolean; status: string }>(
    "SELECT required, status FROM document_requests WHERE case_id = $1 AND firm_id = $2", [caseRow.id, firmId]);
  const required = requests.filter((r) => r.required);
  return {
    statement,
    unverified_reasons: reasons,
    documents: {
      required_outstanding: required.filter((r) => r.status === "requested").length,
      required_received: required.filter((r) => r.status === "received").length,
      required_waived: required.filter((r) => r.status === "waived").length,
      optional_outstanding: requests.filter((r) => !r.required && r.status === "requested").length,
      total_requests: requests.length,
    },
  };
}
