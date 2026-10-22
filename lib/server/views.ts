// Response shapes shared by routes. They mirror the Python API exactly
// (statements.upload_view, document_requests.request_view, app._case_view),
// so the existing pages work unchanged.

import type { Db } from "./db";

export const MAX_PDF_BYTES = 4 * 1024 * 1024; // Vercel's request body limit is about 4.5 MB
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_STORED_STATEMENTS_PER_CASE = 5;
export const MAX_PDF_PAGES = 100;

export function uploadLimits() {
  return { pdf_bytes: MAX_PDF_BYTES, csv_bytes: MAX_CSV_BYTES, statements_per_case: MAX_STORED_STATEMENTS_PER_CASE,
    pdf_pages: MAX_PDF_PAGES };
}

export function caseView(c: { reference: string; financial_year: string; status: string; created_at: Date; updated_at: Date }) {
  return { reference: c.reference, financial_year: c.financial_year, status: c.status, created_at: c.created_at,
    updated_at: c.updated_at };
}

type UploadRow = {
  id: string; file_type: string; display_name: string; size_bytes: number; status: string; error_code: string | null;
  reasons_json: unknown[]; page_warnings_json: unknown[]; rejected_rows_json: unknown[]; duplicate_rows_json: unknown[];
  pages_total: number | null; rows_extracted: number; rows_rejected: number; rows_duplicate: number; rows_summary: number;
  period_start: string | null; period_end: string | null; created_at: Date;
};

export function uploadView(u: UploadRow) {
  return {
    id: u.id, file_type: u.file_type, display_name: u.display_name, size_bytes: u.size_bytes, status: u.status,
    error_code: u.error_code, reasons: u.reasons_json, page_warnings: u.page_warnings_json,
    rejected_rows: u.rejected_rows_json, duplicate_rows: u.duplicate_rows_json, pages_total: u.pages_total,
    rows_extracted: u.rows_extracted, rows_rejected: u.rows_rejected, rows_duplicate: u.rows_duplicate,
    rows_summary: u.rows_summary, period_start: u.period_start, period_end: u.period_end, uploaded_at: u.created_at,
  };
}

export async function caseUploads(db: Db, firmId: string, caseId: string) {
  const rows = await db.query<UploadRow>(
    "SELECT * FROM statement_uploads WHERE case_id = $1 AND firm_id = $2 ORDER BY created_at DESC, id",
    [caseId, firmId]);
  return rows.map(uploadView);
}

type RequestRow = { id: string; label: string; description: string | null; required: boolean; status: string; created_at: Date };
type FileRow = { id: string; request_id: string; display_name: string; content_type: string; size_bytes: number; created_at: Date };

/** A case's document requests with their files; file IDs only for the CA. */
export async function documentRequestViews(db: Db, firmId: string, caseId: string, forCa: boolean) {
  const requests = await db.query<RequestRow>(
    "SELECT id, label, description, required, status, created_at FROM document_requests WHERE case_id = $1 AND firm_id = $2 ORDER BY created_at",
    [caseId, firmId]);
  const files = await db.query<FileRow>(
    `SELECT id, request_id, display_name, content_type, size_bytes, created_at FROM documents
     WHERE case_id = $1 AND firm_id = $2 AND kind = 'supporting' ORDER BY created_at`, [caseId, firmId]);
  return requests.map((r) => ({
    id: r.id, label: r.label, description: r.description, required: r.required, status: r.status, created_at: r.created_at,
    files: files.filter((f) => f.request_id === r.id).map((f) => ({
      ...(forCa ? { id: f.id } : {}), display_name: f.display_name, content_type: f.content_type,
      size_bytes: f.size_bytes, uploaded_at: f.created_at,
    })),
  }));
}
