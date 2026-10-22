// AIS / TIS / Form 26AS reports uploaded by the CA for a case (migration 0006):
// validation, private storage, the records read from them, the CA's verdicts
// and the view combining them with the reconciliation. Only fixed codes, IDs
// and counts are logged or audited, never report contents.

import { reconcileTaxReports, type BankCredit, type Reconciliation, type ReconRecordInput } from "../statement/tax-reconcile";
import { parseTaxReport, TAX_REPORT_KINDS, type TaxRecordCategory, type TaxReportKind } from "../statement/tax-report";
import { formatPaise, parseAmount } from "../statement/validation";
import { recordAudit } from "./audit";
import type { Db } from "./db";
import { Conflict, guarded } from "./errors";
import { isId, newId, sha256Hex } from "./ids";
import { sanitiseDisplayName } from "./statements";
import { checkKey, StorageError, storageKey, type FileStore } from "./storage";

export const MAX_TAX_REPORT_BYTES = 4 * 1024 * 1024;
const CONTENT_TYPES = { csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };

export class TaxReportRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TaxReportRefused";
  }
}

type CaseRef = { id: string; status: string };

/** Validate, read and store one report. Throws TaxReportRefused; nothing is stored for a refused file. */
export async function uploadTaxReport(db: Db, store: FileStore, input: { firmId: string; caseRow: CaseRef; actorId: string;
  kind: unknown; data: Uint8Array; filename: string }): Promise<{ reportId: string; records: number; warnings: number }> {
  const { firmId, caseRow, data } = input;
  if (caseRow.status === "closed") throw new TaxReportRefused("case_closed");
  if (typeof input.kind !== "string" || !(TAX_REPORT_KINDS as readonly string[]).includes(input.kind)) {
    throw new TaxReportRefused("invalid_kind");
  }
  if (data.length > MAX_TAX_REPORT_BYTES) throw new TaxReportRefused("file_too_large");
  const parsed = await parseTaxReport(data, input.filename);
  if (!parsed.ok) throw new TaxReportRefused(parsed.code);
  const digest = sha256Hex(data);
  const [existing] = await db.query("SELECT id FROM documents WHERE case_id = $1 AND firm_id = $2 AND kind = 'tax_report' AND sha256 = $3",
    [caseRow.id, firmId, digest]);
  if (existing) throw new TaxReportRefused("already_uploaded");

  const documentId = newId();
  const reportId = newId();
  const key = storageKey(firmId, caseRow.id, documentId, parsed.fileType);
  await store.put(key, data, CONTENT_TYPES[parsed.fileType]);
  try {
    await guarded(() => db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents (id, case_id, firm_id, kind, storage_key, display_name, content_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, 'tax_report', $4, $5, $6, $7, $8, 'ca')`,
        [documentId, caseRow.id, firmId, key, sanitiseDisplayName(input.filename), CONTENT_TYPES[parsed.fileType], data.length, digest]);
      await tx.query(
        `INSERT INTO tax_reports (id, case_id, firm_id, document_id, kind, file_type, display_name, records_count, warnings_json, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10)`,
        [reportId, caseRow.id, firmId, documentId, input.kind, parsed.fileType, sanitiseDisplayName(input.filename),
          parsed.records.length, JSON.stringify(parsed.warnings.slice(0, 200)), input.actorId]);
      await tx.query(
        `INSERT INTO tax_report_records (report_id, case_id, firm_id, source_row, category, description, party, txn_date, amount,
           tax_deducted, raw_json)
         SELECT $1, $2, $3, r.source_row, r.category, r.description, r.party, r.txn_date, r.amount, r.tax_deducted, r.raw
         FROM jsonb_to_recordset($4::text::jsonb) AS r(source_row int, category text, description text, party text,
           txn_date date, amount numeric, tax_deducted numeric, raw jsonb)`,
        [reportId, caseRow.id, firmId, JSON.stringify(parsed.records.map((r) => ({
          source_row: r.sourceRow, category: r.category, description: r.description, party: r.party, txn_date: r.date,
          amount: formatPaise(r.amount), tax_deducted: r.taxDeducted === null ? null : formatPaise(r.taxDeducted), raw: r.raw,
        })))]);
      await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id, action: "tax_report.uploaded",
        details: { report_id: reportId, kind: input.kind, records: parsed.records.length, warnings: parsed.warnings.length } });
    }), "tax_report");
  } catch (error) {
    await store.remove(key).catch(() => undefined);
    if (error instanceof Conflict && error.code === "duplicate_document") throw new TaxReportRefused("already_uploaded");
    throw error;
  }
  return { reportId, records: parsed.records.length, warnings: parsed.warnings.length };
}

type ReportRow = { id: string; kind: TaxReportKind; file_type: string; display_name: string; records_count: number;
  warnings_json: { row: number; code: string }[]; created_at: Date };
type RecordRow = { id: string; report_id: string; source_row: number; category: TaxRecordCategory; description: string;
  party: string | null; txn_date: string | null; amount: string; tax_deducted: string | null;
  review_status: "confirmed" | "unresolved" | null; review_note: string | null; reviewed_match: string | null; reviewed_at: Date | null };

async function loadReports(db: Db, firmId: string, caseId: string) {
  const reports = await db.query<ReportRow>(
    `SELECT id, kind, file_type, display_name, records_count, warnings_json, created_at FROM tax_reports
     WHERE case_id = $1 AND firm_id = $2 AND withdrawn_at IS NULL ORDER BY created_at, id`, [caseId, firmId]);
  const records = reports.length ? await db.query<RecordRow>(
    `SELECT r.id, r.report_id, r.source_row, r.category, r.description, r.party, r.txn_date::text AS txn_date,
            r.amount::text AS amount, r.tax_deducted::text AS tax_deducted, r.review_status, r.review_note, r.reviewed_match,
            r.reviewed_at
     FROM tax_report_records r JOIN tax_reports t ON t.id = r.report_id AND t.firm_id = r.firm_id
     WHERE r.case_id = $1 AND r.firm_id = $2 AND t.withdrawn_at IS NULL ORDER BY t.created_at, t.id, r.source_row`,
    [caseId, firmId]) : [];
  return { reports, records };
}


function reconcile(reports: ReportRow[], records: RecordRow[], bank: BankCredit[]): Reconciliation {
  const order = new Map(reports.map((r, i) => [r.id, i]));
  const kinds = new Map(reports.map((r) => [r.id, r.kind]));
  const inputs: ReconRecordInput[] = records.map((r) => ({
    id: r.id, reportId: r.report_id, reportKind: kinds.get(r.report_id)!, reportOrder: order.get(r.report_id)!,
    sourceRow: r.source_row, category: r.category, description: r.description, party: r.party, date: r.txn_date,
    amount: parseAmount(r.amount), taxDeducted: r.tax_deducted === null ? null : parseAmount(r.tax_deducted),
    reviewStatus: r.review_status,
    reviewedMatch: r.reviewed_match,
  }));
  return reconcileTaxReports(inputs, bank);
}

/** The reconciliation of the case's reports against these bank credits (the reviewed rows, CA decisions applied). */
export async function taxReconciliation(db: Db, firmId: string, caseId: string, bank: BankCredit[] | null) {
  const { reports, records } = await loadReports(db, firmId, caseId);
  const result = reconcile(reports, records, bank ?? []);
  const byId = new Map(result.results.map((r) => [r.id, r]));
  const kinds = new Map(reports.map((r) => [r.id, r.kind]));
  return {
    status: result.status, open_count: result.openCount, review_prepared: bank !== null,
    reports: reports.map((r) => ({ id: r.id, kind: r.kind, file_type: r.file_type, display_name: r.display_name,
      records_count: r.records_count, warnings: r.warnings_json, uploaded_at: r.created_at })),
    records: records.map((r) => {
      const m = byId.get(r.id)!;
      return { id: r.id, report_id: r.report_id, report_kind: kinds.get(r.report_id)!, source_row: r.source_row,
        category: r.category, description: r.description, party: r.party, date: r.txn_date, amount: r.amount,
        tax_deducted: r.tax_deducted, status: m.status, bank_rows: m.bankRows,
        bank_amount: m.bankAmount === null ? null : formatPaise(m.bankAmount),
        difference: m.difference === null ? null : formatPaise(m.difference), duplicate_of: m.duplicateOf, review: m.review,
        stale_review: m.staleReview, note: r.review_note, signature: m.signature };
    }),
    bank_only: result.bankOnly.map((b) => ({ row_number: b.rowNumber, date: b.date, amount: formatPaise(b.credit),
      category: b.category, narration: b.narration })),
    summary: result.summary,
  };
}

/** The CA's verdict on one record: confirmed (accept as reconciled), unresolved, or null to withdraw it. */
export async function reviewTaxRecord(db: Db, input: { firmId: string; caseRow: CaseRef; actorId: string; recordId: unknown;
  status: "confirmed" | "unresolved" | null; note: unknown; signature: unknown }): Promise<boolean> {
  const { firmId, caseRow } = input;
  if (caseRow.status === "closed") throw new TaxReportRefused("case_closed");
  if (!isId(input.recordId)) return false;
  let note: string | null = null;
  if (input.status !== null && input.note !== null && input.note !== undefined) {
    if (typeof input.note !== "string") throw new TaxReportRefused("invalid_note");
    note = input.note.replace(/\s+/g, " ").trim() || null;
    if (note && (note.length > 300 || /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(note))) throw new TaxReportRefused("invalid_note");
  }
  if (input.status !== null && (typeof input.signature !== "string" || input.signature.length > 2000)) {
    throw new TaxReportRefused("invalid_signature");
  }
  return db.transaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `SELECT r.id FROM tax_report_records r JOIN tax_reports t ON t.id = r.report_id AND t.firm_id = r.firm_id
       WHERE r.id = $1 AND r.case_id = $2 AND r.firm_id = $3 AND t.withdrawn_at IS NULL FOR UPDATE OF r`,
      [input.recordId, caseRow.id, firmId]);
    if (!row) return false;
    await tx.query(
      `UPDATE tax_report_records SET review_status = $4, review_note = $5, reviewed_match = $6,
         reviewed_by = CASE WHEN $4::text IS NULL THEN NULL ELSE $7::uuid END,
         reviewed_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END
       WHERE id = $1 AND case_id = $2 AND firm_id = $3`,
      [row.id, caseRow.id, firmId, input.status, note, input.status === null ? null : input.signature, input.actorId]);
    await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id, action: "tax_report.record_reviewed",
      details: { record_id: row.id, status: input.status } });
    return true;
  });
}

/** Take a wrongly uploaded report out of the reconciliation (the file and records are kept for the audit trail). */
export async function withdrawTaxReport(db: Db, input: { firmId: string; caseRow: CaseRef; actorId: string; reportId: unknown }) {
  if (input.caseRow.status === "closed") throw new TaxReportRefused("case_closed");
  if (!isId(input.reportId)) return false;
  const rows = await db.query(
    "UPDATE tax_reports SET withdrawn_at = now() WHERE id = $1 AND case_id = $2 AND firm_id = $3 AND withdrawn_at IS NULL RETURNING id",
    [input.reportId, input.caseRow.id, input.firmId]);
  if (!rows.length) return false;
  await recordAudit(db, { actorKind: "ca", actorId: input.actorId, firmId: input.firmId, caseId: input.caseRow.id,
    action: "tax_report.withdrawn", details: { report_id: input.reportId } });
  return true;
}

/** The original uploaded file of a report of the CA's case, or null. */
export async function loadTaxReportFile(db: Db, store: FileStore, input: { firmId: string; caseId: string; reportId: unknown;
  actorId: string }) {
  if (!isId(input.reportId)) return null;
  const [doc] = await db.query<{ id: string; storage_key: string; content_type: string; file_type: string }>(
    `SELECT d.id, d.storage_key, d.content_type, t.file_type FROM tax_reports t
     JOIN documents d ON d.id = t.document_id AND d.case_id = t.case_id AND d.firm_id = t.firm_id
     WHERE t.id = $1 AND t.case_id = $2 AND t.firm_id = $3 AND d.kind = 'tax_report'`, [input.reportId, input.caseId, input.firmId]);
  if (!doc) return null;
  try {
    checkKey(doc.storage_key);
    const data = await store.get(doc.storage_key);
    await recordAudit(db, { actorKind: "ca", actorId: input.actorId, firmId: input.firmId, caseId: input.caseId,
      action: "tax_report.downloaded", details: { report_id: input.reportId } });
    return { data, contentType: doc.content_type, filename: `${input.reportId}.${doc.file_type}` };
  } catch (error) {
    if (error instanceof StorageError) return null;
    throw error;
  }
}
