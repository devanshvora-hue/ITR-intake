// CA case review (port of case_review.py): turn one stored statement upload
// into the case's classified `statement_rows`, and show the stored review.
//
// prepareReview: the upload must be a stored statement of this case whose
// outcome was `extracted` or `manual_review_required`; the case must not be
// closed. The stored file is read again (CSV parser, or pdf.js for PDFs),
// validated and classified. In one transaction the case's rows are replaced,
// the case records the upload, period, balances, classifier version and time,
// and moves to `ca_review_required`. A review built from a manual-review
// upload, with invalid rows, or whose balance check does not pass, is reported
// as unverified. Nothing here logs narrations, amounts or file names.

import { recordAudit } from "./audit";
import { syncCaseStatus } from "./case-status";
import { refreshChecklist } from "./checklist";
import type { CaseRow } from "./client-auth";
import type { Db } from "./db";
import { Conflict } from "./errors";
import { PREPARABLE_UPLOAD_STATUSES, verification } from "./readiness";
import { checkKey, type FileStore, StorageError } from "./storage";
import { uploadView } from "./views";
import { classifyStatement, type Category as ClassifiedCategory } from "../statement/classifier";
import type { TransactionMode as ClassifiedMode } from "../statement/text";
import { buildWorkbook } from "../statement/workbook";
import { parseCsv, parsePdfPages, REJECTED, type ImportResult } from "../statement/import";
import { containsImages, ExtractionFailed, ExtractorBusy, extractPdfPages } from "../statement/pdf-text";
import { formatPaise, parseAmount, parseDate, validateRows, type RawTransaction } from "../statement/validation";

export const CLASSIFIER_VERSION = "itr_intake.classifier/stage5.8";
const PREPARABLE_CASE_STATUSES = ["statement_uploaded", "ca_review_required", "documents_pending", "review_ready"];

export class ReviewRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReviewRefused";
  }
}

export type ReviewCase = CaseRow & {
  opening_balance: string | null; closing_balance: string | null; period_start: string | null; period_end: string | null;
  classifier_version: string | null; reviewed_at: Date | null;
};

/** Opening and closing balances implied by the rows' own balances, in date order; null when any is missing. */
function balances(rows: RawTransaction[]): { opening: bigint | null; closing: bigint | null } {
  if (!rows.length || rows.some((r) => r.balance === null)) return { opening: null, closing: null };
  let parsed: [string, bigint, bigint, bigint][];
  try {
    parsed = rows.map((r) => [parseDate(r.date ?? ""), parseAmount(r.debit), parseAmount(r.credit), parseAmount(r.balance, true)]);
  } catch {
    return { opening: null, closing: null };
  }
  if (parsed.length > 1 && parsed[0][0] > parsed[parsed.length - 1][0]) parsed.reverse();
  const first = parsed[0], last = parsed[parsed.length - 1];
  return { opening: first[3] - first[2] + first[1], closing: last[3] };
}

async function readStatement(data: Uint8Array, fileType: string, financialYear: string): Promise<ImportResult> {
  if (fileType === "csv") return parseCsv(data, financialYear);
  try {
    return parsePdfPages(await extractPdfPages(data), financialYear, containsImages(data));
  } catch (error) {
    if (error instanceof ExtractionFailed) throw new ReviewRefused(error.code);
    throw error;
  }
}

/**
 * Prepare (or re-prepare) the case's review from one stored upload. Returns
 * nothing; reload the case. Throws ReviewRefused (fixed codes), ExtractorBusy,
 * or Conflict("stale_version") if the case changed meanwhile. An upload of
 * another case is ReviewRefused("not_found").
 */
export async function prepareReview(db: Db, store: FileStore, input: {
  firmId: string; caseRow: ReviewCase; uploadId: string; actorId: string;
}): Promise<void> {
  const { firmId, caseRow } = input;
  if (caseRow.status === "closed") throw new ReviewRefused("case_closed");
  if (!PREPARABLE_CASE_STATUSES.includes(caseRow.status)) throw new ReviewRefused("invalid_case_status");
  const [upload] = await db.query<{ id: string; status: string; file_type: string; document_id: string | null }>(
    "SELECT id, status, file_type, document_id FROM statement_uploads WHERE id = $1 AND case_id = $2 AND firm_id = $3",
    [input.uploadId, caseRow.id, firmId]);
  if (!upload) throw new ReviewRefused("not_found");
  if (!PREPARABLE_UPLOAD_STATUSES.includes(upload.status) || upload.document_id === null) {
    throw new ReviewRefused("statement_not_usable");
  }
  const [document] = await db.query<{ storage_key: string }>(
    "SELECT storage_key FROM documents WHERE id = $1 AND case_id = $2 AND firm_id = $3 AND kind = 'bank_statement'",
    [upload.document_id, caseRow.id, firmId]);
  if (!document) throw new ReviewRefused("file_missing");
  let data: Uint8Array;
  try {
    checkKey(document.storage_key);
    data = await store.get(document.storage_key);
  } catch (error) {
    if (error instanceof StorageError) throw new ReviewRefused(error.code === "not_found" ? "file_missing" : "file_unavailable");
    throw error;
  }

  const result = await readStatement(data, upload.file_type, caseRow.financial_year);
  if (result.status === REJECTED) throw new ReviewRefused("statement_not_usable");

  const usable = result.transactions;
  // The balances printed on the statement win; otherwise they are derived from the rows' own balances.
  const derived = balances(usable);
  const bal = {
    opening: result.statedOpening !== null ? parseAmount(result.statedOpening, true) : derived.opening,
    closing: result.statedClosing !== null ? parseAmount(result.statedClosing, true) : derived.closing,
  };
  const report = validateRows(usable);
  const profile = (caseRow.profile_json ?? {}) as { full_name?: string };
  const classified = new Map(classifyStatement(report.transactions, { name: profile.full_name || caseRow.client_first_name })
    .map((t) => [t.rowNumber, t]));
  const issues = new Map<number, string[]>();
  for (const issue of report.errors) issues.set(issue.rowNumber, [...(issues.get(issue.rowNumber) ?? []), issue.code]);

  type Row = Record<string, unknown> & { row_number: number };
  const rows: Row[] = result.rejected.map((r) => ({ row_number: r.row, is_valid: false, issues: r.codes,
    source_page: r.page ?? null }));
  for (const r of usable) {
    const t = classified.get(r.rowNumber);
    const raw = { raw_date: r.date, raw_narration: r.narration, raw_debit: r.debit, raw_credit: r.credit, raw_balance: r.balance,
      source_page: result.rowPages.get(r.rowNumber) ?? null };
    if (!t) {
      rows.push({ row_number: r.rowNumber, is_valid: false, issues: issues.get(r.rowNumber) ?? ["invalid_row"], ...raw });
      continue;
    }
    rows.push({
      row_number: r.rowNumber, is_valid: true, issues: issues.get(r.rowNumber) ?? [], flags: t.flags, ...raw,
      txn_date: t.date, narration: t.narration, debit: formatPaise(t.debit), credit: formatPaise(t.credit),
      balance: t.balance === null ? null : formatPaise(t.balance), mode: t.mode, counterparty: t.counterparty,
      category: t.category, confidence: t.confidence, review_status: t.reviewStatus, matched_rule: t.matchedRule,
      classification_reason: t.classificationReason, classifier_version: CLASSIFIER_VERSION,
    });
  }
  rows.sort((a, b) => a.row_number - b.row_number);
  const dates = report.transactions.map((t) => t.date).sort();

  await db.transaction(async (tx) => {
    await tx.query("DELETE FROM statement_rows WHERE case_id = $1 AND firm_id = $2", [caseRow.id, firmId]);
    if (rows.length) {
      // One INSERT from a JSON array keeps the round trips low for long statements.
      await tx.query(
        `INSERT INTO statement_rows (case_id, firm_id, row_number, is_valid, issues_json, flags_json, raw_date,
           raw_narration, raw_debit, raw_credit, raw_balance, txn_date, narration, debit, credit, balance, mode,
           counterparty, category, confidence, review_status, matched_rule, classification_reason, classifier_version,
           source_page)
         SELECT $1, $2, r.row_number, r.is_valid, COALESCE(r.issues, '[]'::jsonb), COALESCE(r.flags, '[]'::jsonb),
           r.raw_date, r.raw_narration, r.raw_debit, r.raw_credit, r.raw_balance, r.txn_date, r.narration, r.debit,
           r.credit, r.balance, r.mode, r.counterparty, r.category, r.confidence, r.review_status, r.matched_rule,
           r.classification_reason, r.classifier_version, r.source_page
         FROM jsonb_to_recordset($3::text::jsonb) AS r(row_number int, is_valid boolean, issues jsonb, flags jsonb,
           raw_date text, raw_narration text, raw_debit text, raw_credit text, raw_balance text, txn_date date,
           narration text, debit numeric, credit numeric, balance numeric, mode text, counterparty text, category text,
           confidence text, review_status text, matched_rule text, classification_reason text, classifier_version text,
           source_page int)`,
        [caseRow.id, firmId, JSON.stringify(rows)]);
    }
    const updated = await tx.query(
      `UPDATE cases SET status = 'ca_review_required', classifier_version = $4, reviewed_upload_id = $5,
              reviewed_at = now(), period_start = $6::date, period_end = $7::date, opening_balance = $8::numeric,
              closing_balance = $9::numeric, version = version + 1, updated_at = now()
       WHERE id = $1 AND firm_id = $2 AND version = $3 RETURNING id`,
      [caseRow.id, firmId, caseRow.version, CLASSIFIER_VERSION, upload.id, dates[0] ?? null, dates[dates.length - 1] ?? null,
        bal.opening === null ? null : formatPaise(bal.opening), bal.closing === null ? null : formatPaise(bal.closing)]);
    if (!updated.length) throw new Conflict("stale_version");
    await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id, action: "case.review_prepared",
      details: { upload_id: upload.id, rows: rows.length } });
    await syncCaseStatus(tx, firmId, caseRow.id); // outstanding document requests keep it "documents_pending"
    await refreshChecklist(tx, firmId, caseRow.id); // newly classified activity changes the suggestions
  });
}

export { ExtractorBusy };

type StoredRow = {
  row_number: number; is_valid: boolean; issues_json: string[]; txn_date: string | null; narration: string | null;
  debit: string | null; credit: string | null; balance: string | null; category: string | null; confidence: string | null;
  review_status: string | null; flags_json: string[]; classification_reason: string | null; matched_rule: string | null;
  mode: string | null; counterparty: string | null; raw_debit: string | null; raw_credit: string | null; raw_balance: string | null;
  source_page: number | null;
};

export async function storedRows(db: Db, firmId: string, caseId: string): Promise<StoredRow[]> {
  return db.query<StoredRow>(
    `SELECT row_number, is_valid, issues_json, txn_date, narration, debit::text AS debit, credit::text AS credit,
            balance::text AS balance, category, confidence, review_status, flags_json, classification_reason,
            matched_rule, mode, counterparty, raw_debit, raw_credit, raw_balance, source_page
     FROM statement_rows WHERE case_id = $1 AND firm_id = $2 ORDER BY row_number`, [caseId, firmId]);
}

/** The stored review of a case for its own firm's CA, or null. */
export async function reviewView(db: Db, firmId: string, caseRow: ReviewCase) {
  if (!caseRow.reviewed_upload_id) return null;
  const [upload] = await db.query<Parameters<typeof uploadView>[0]>(
    "SELECT * FROM statement_uploads WHERE id = $1 AND case_id = $2 AND firm_id = $3",
    [caseRow.reviewed_upload_id, caseRow.id, firmId]);
  if (!upload) return null;
  const rows = await storedRows(db, firmId, caseRow.id);
  const check = verification(caseRow, upload.status, rows);
  return {
    statement: uploadView(upload),
    prepared_at: caseRow.reviewed_at,
    classifier_version: caseRow.classifier_version,
    period_start: caseRow.period_start,
    period_end: caseRow.period_end,
    verified: check.verified,
    unverified_reasons: check.unverifiedReasons,
    totals: {
      rows: rows.length, valid: check.validCount, invalid: check.invalid,
      needs_review: rows.filter((r) => r.is_valid && r.review_status !== "Auto-classified").length,
      credits: formatPaise(check.credits), debits: formatPaise(check.debits),
    },
    reconciliation: check.reconciliation,
    rows: rows.map((r) => ({
      row_number: r.row_number, is_valid: r.is_valid, issues: r.issues_json, date: r.txn_date, narration: r.narration,
      debit: r.debit, credit: r.credit, balance: r.balance, category: r.category, confidence: r.confidence,
      review_status: r.review_status, flags: r.flags_json, classification_reason: r.classification_reason,
      source_page: r.source_page,
    })),
  };
}

// --- internal workbook ---------------------------------------------------------------------------------------

export class NoReview extends Error {
  constructor() {
    super("no review");
    this.name = "NoReview";
  }
}

const UNVERIFIED_TEXT: Record<string, string> = {
  statement_needs_manual_review: "the statement needs manual review",
  rows_invalid: "some rows could not be read",
  balance_check_not_passed: "the running balance does not reconcile or could not be checked",
};

/**
 * The internal workbook for the case's stored review, built only from the
 * stored rows and case/upload metadata (the original file is not read).
 * Throws NoReview when there is none. Summary row 3 states whether the
 * review is verified.
 */
export async function buildCaseWorkbook(db: Db, firmId: string, caseRow: ReviewCase): Promise<Uint8Array> {
  const view = await reviewView(db, firmId, caseRow);
  if (!view) throw new NoReview();
  const rows = await storedRows(db, firmId, caseRow.id);
  const invalid = rows.filter((r) => !r.is_valid);
  const transactions = rows.filter((r) => r.is_valid).map((r) => ({
    rowNumber: r.row_number, date: r.txn_date as string, narration: r.narration as string,
    debit: parseAmount(r.debit), credit: parseAmount(r.credit), balance: r.balance === null ? null : parseAmount(r.balance, true),
    rawDebit: r.raw_debit, rawCredit: r.raw_credit, rawBalance: r.raw_balance,
    mode: (r.mode ?? "Other") as ClassifiedMode, counterparty: r.counterparty,
    category: r.category as ClassifiedCategory, classificationReason: r.classification_reason ?? "",
    confidence: (r.confidence ?? "low") as "high" | "medium" | "low",
    reviewStatus: (r.review_status ?? "Needs review") as "Auto-classified" | "Needs confirmation" | "Needs review",
    matchedRule: r.matched_rule ?? "uncertain", flags: r.flags_json,
  }));
  const rec = view.reconciliation;
  const reconciliation = rec.status === "not_available" ? null : {
    status: rec.status as "passed" | "failed" | "incomplete", opening: parseAmount(rec.opening_balance, true),
    stated: parseAmount(rec.stated_closing, true), difference: parseAmount(rec.difference, true),
  };
  const prepared = view.prepared_at instanceof Date ? view.prepared_at.toISOString() : String(view.prepared_at ?? "");
  let note = `Review of uploaded ${view.statement.file_type.toUpperCase()} statement '${view.statement.display_name}', `
    + `prepared ${prepared.slice(0, 16).replace("T", " ")} UTC.`;
  if (invalid.length) {
    const listed = invalid.slice(0, 30).map((r) => `${r.row_number} (${r.issues_json.join("/")})`).join(", ");
    note += ` Rows not read: ${listed}${invalid.length > 30 ? " and more" : ""}.`;
  }
  const profile = (caseRow.profile_json ?? {}) as { full_name?: string; bank_name?: string; account_last4?: string };
  return buildWorkbook({
    transactions, rowsReceived: rows.length, invalidCount: invalid.length, reconciliation,
    metadata: {
      clientName: profile.full_name || caseRow.client_first_name, clientReference: caseRow.reference,
      bankName: profile.bank_name, accountNumber: profile.account_last4, financialYear: caseRow.financial_year,
      periodStart: caseRow.period_start, periodEnd: caseRow.period_end, dataSourceNote: note,
    },
    statusLine: view.verified
      ? { text: "Verified extraction: every row was read and the running balance reconciles.", verified: true }
      : { text: `UNVERIFIED REVIEW - do not rely on these figures without checking the statement: ${
        view.unverified_reasons.map((r) => UNVERIFIED_TEXT[r] ?? r).join("; ")}.`, verified: false },
  });
}

/** A case of the caller's firm by reference (with the client's e-mail), or null. */
export async function firmCaseByReference(db: Db, firmId: string, reference: unknown):
  Promise<(ReviewCase & { client_email: string; client_email_verified: boolean }) | null> {
  if (typeof reference !== "string" || !/^IT-[A-Z]{1,12}-[0-9A-Z]{6}$/.test(reference)) return null;
  const [row] = await db.query<ReviewCase & { client_email: string; client_email_verified: boolean }>(
    `SELECT c.*, c.opening_balance::text AS opening_balance, c.closing_balance::text AS closing_balance,
            c.period_start::text AS period_start, c.period_end::text AS period_end, i.email_norm AS client_email,
            i.email_verified_at IS NOT NULL AS client_email_verified
     FROM cases c JOIN client_identities i ON i.id = c.client_identity_id AND i.firm_id = c.firm_id
     WHERE c.reference = $1 AND c.firm_id = $2`, [reference, firmId]);
  return row ?? null;
}
