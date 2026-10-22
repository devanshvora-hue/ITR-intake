// Bank-statement uploads (ported from statements.py): file checks, private
// storage, PDF/CSV reading and the recorded outcome.
//
// One upload: size, extension, declared content type and the file's real
// signature are checked; anything wrong is recorded as 'rejected' and the
// bytes are discarded. A repeat of a stored file returns the existing upload.
// CSV is parsed in memory; PDF text is read in process (pdf.js). A file-level
// failure is 'rejected' and never stored. Otherwise the file goes to private
// storage under "<firm>/<case>/<document>.<ext>" and the document, upload
// record, case status and audit event are written in one transaction; if that
// fails the stored file is removed. Only counts, codes, row and page numbers
// are stored or logged; never file contents or transactions.

import { recordAudit } from "./audit";
import { syncCaseStatus } from "./case-status";
import type { CaseRow } from "./client-auth";
import type { Db } from "./db";
import { Conflict, guarded } from "./errors";
import { newId, sha256Hex } from "./ids";
import { storageKey, type FileStore } from "./storage";
import { MAX_CSV_BYTES, MAX_PDF_BYTES, MAX_STORED_STATEMENTS_PER_CASE } from "./views";
import { parseCsv, parsePdfPages, REJECTED, rejectedFile, type ImportResult } from "../statement/import";
import { containsImages, ExtractionFailed, ExtractorBusy, extractPdfPages } from "../statement/pdf-text";

const JSON_LIMIT = 200; // list fields kept per upload
const CONTENT_TYPES: Record<string, Set<string>> = {
  pdf: new Set(["", "application/pdf", "application/x-pdf", "application/octet-stream"]),
  csv: new Set(["", "text/csv", "application/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream",
    "text/comma-separated-values"]),
};
const BINARY_MAGIC = ["%PDF", "PK\x03\x04", "\x89PNG", "\xff\xd8\xff", "GIF8", "\xd0\xcf\x11\xe0", "Rar!", "7z\xbc\xaf",
  "\x1f\x8b", "MZ", "BM", "II*\x00", "MM\x00*"];

export class UploadRefused extends Error {
  constructor(readonly code: "upload_limit_reached" | "busy") {
    super(code);
    this.name = "UploadRefused";
  }
}

/** A display-only name: last path component, safe characters, at most 100. Never used as a path. */
export function sanitiseDisplayName(name: unknown): string {
  let text = typeof name === "string" ? name : "";
  text = text.split(/[\\/]/).pop() ?? "";
  text = [...text.normalize("NFKC")].map((ch) => (/[\p{L}\p{N} ._()-]/u.test(ch) ? ch : "_")).join("")
    .replace(/^[ .]+|[ .]+$/g, "");
  text = text.replace(/_+/g, "_").slice(0, 100).trim();
  return text || "statement";
}

function extension(name: unknown): string {
  const m = /\.([A-Za-z0-9]{1,8})\s*$/.exec(typeof name === "string" ? name : "");
  return m ? m[1].toLowerCase() : "";
}

function startsWith(data: Uint8Array, magic: string): boolean {
  if (data.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (data[i] !== magic.charCodeAt(i)) return false;
  return true;
}

export function detectType(data: Uint8Array): "pdf" | "csv" | null {
  if (startsWith(data, "%PDF-")) return "pdf";
  if (BINARY_MAGIC.some((m) => startsWith(data, m)) || data.subarray(0, 4096).includes(0)) return null;
  return "csv"; // text without NUL bytes; the CSV parser refuses non-UTF-8 with its own reason
}

/** [fileType, errorCode]; errorCode null means the file may be processed. */
export function checkUpload(data: Uint8Array, filename: unknown, contentType: unknown): [string, string | null] {
  const ext = extension(filename);
  const claimed = ext === "pdf" || ext === "csv" ? ext : "unknown";
  if (!data.length) return [claimed, "empty_file"];
  if (ext !== "pdf" && ext !== "csv") return [claimed, "unsupported_file_type"];
  const detected = detectType(data);
  if (detected === null) return [claimed, "unsupported_content"];
  if (detected !== ext) return [claimed, "type_mismatch"];
  const declared = (typeof contentType === "string" ? contentType : "").split(";")[0].trim().toLowerCase();
  if (!CONTENT_TYPES[ext].has(declared)) return [claimed, "type_mismatch"];
  if (data.length > (ext === "pdf" ? MAX_PDF_BYTES : MAX_CSV_BYTES)) return [claimed, "file_too_large"];
  if (ext === "pdf" && !new TextDecoder("latin1").decode(data.subarray(Math.max(0, data.length - 2048))).includes("%%EOF")) {
    return [claimed, "truncated_pdf"];
  }
  return [ext, null];
}

async function processFile(data: Uint8Array, fileType: "pdf" | "csv", financialYear: string): Promise<ImportResult> {
  if (fileType === "csv") return parseCsv(data, financialYear);
  try {
    const pages = await extractPdfPages(data);
    return parsePdfPages(pages, financialYear, containsImages(data));
  } catch (error) {
    if (error instanceof ExtractionFailed) return rejectedFile("pdf", error.code);
    throw error;
  }
}

function resultFields(result: ImportResult) {
  return {
    reasons: result.reviewReasons,
    page_warnings: result.pageWarnings.slice(0, JSON_LIMIT),
    rejected_rows: result.rejected.slice(0, JSON_LIMIT),
    duplicate_rows: result.duplicateRows.slice(0, JSON_LIMIT),
    pages_total: result.pagesTotal,
    rows_extracted: result.transactions.length,
    rows_rejected: result.rejected.length,
    rows_duplicate: result.duplicateRows.length,
    rows_summary: result.summaryRows,
    period_start: result.periodStart, // "YYYY-MM-DD"
    period_end: result.periodEnd,
  };
}

type UploadInsert = { fileType: string; displayName: string; size: number; status: string; documentId?: string | null;
  errorCode?: string | null; fields?: ReturnType<typeof resultFields> };

async function insertUpload(db: Db, firmId: string, caseId: string, u: UploadInsert) {
  const f = u.fields;
  const [row] = await guarded(() => db.query(
    `INSERT INTO statement_uploads (case_id, firm_id, document_id, file_type, display_name, size_bytes, status,
       reasons_json, page_warnings_json, rejected_rows_json, duplicate_rows_json, pages_total, rows_extracted,
       rows_rejected, rows_duplicate, rows_summary, period_start, period_end, error_code, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text::jsonb, $9::text::jsonb, $10::text::jsonb, $11::text::jsonb, $12, $13, $14, $15, $16,
             $17::date, $18::date, $19, CASE WHEN $7 = 'processing' THEN NULL ELSE now() END)
     RETURNING *`,
    [caseId, firmId, u.documentId ?? null, u.fileType, u.displayName, u.size, u.status,
      JSON.stringify(f?.reasons ?? []), JSON.stringify(f?.page_warnings ?? []), JSON.stringify(f?.rejected_rows ?? []),
      JSON.stringify(f?.duplicate_rows ?? []), f?.pages_total ?? null, f?.rows_extracted ?? 0, f?.rows_rejected ?? 0,
      f?.rows_duplicate ?? 0, f?.rows_summary ?? 0, f?.period_start ?? null, f?.period_end ?? null, u.errorCode ?? null]),
  "statement_upload");
  return row;
}

async function existingUploadForHash(db: Db, firmId: string, caseId: string, digest: string) {
  const [row] = await db.query(
    `SELECT u.* FROM statement_uploads u JOIN documents d ON d.id = u.document_id
     WHERE d.case_id = $1 AND d.firm_id = $2 AND d.kind = 'bank_statement' AND d.sha256 = $3`, [caseId, firmId, digest]);
  return row ?? null;
}

/**
 * Validate, read and record one upload for a case the caller is authorised
 * for. Throws UploadRefused("upload_limit_reached" | "busy"); nothing is
 * stored or recorded then.
 */
export async function handleStatementUpload(db: Db, store: FileStore, input: {
  firmId: string; caseRow: CaseRow; actorId: string; data: Uint8Array; filename: unknown; contentType: unknown;
}): Promise<{ upload: Record<string, unknown>; created: boolean }> {
  const { firmId, caseRow, data } = input;
  const caseId = caseRow.id;
  const displayName = sanitiseDisplayName(input.filename);
  const [fileType, error] = checkUpload(data, input.filename, input.contentType);
  if (error) {
    const upload = await insertUpload(db, firmId, caseId, { fileType, displayName, size: data.length, status: REJECTED,
      errorCode: error });
    console.info("statement rejected", fileType, error);
    return { upload, created: true };
  }

  const digest = sha256Hex(data);
  const existing = await existingUploadForHash(db, firmId, caseId, digest);
  if (existing) return { upload: existing, created: false };
  const [{ n }] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM statement_uploads WHERE case_id = $1 AND firm_id = $2 AND document_id IS NOT NULL",
    [caseId, firmId]);
  if (n >= MAX_STORED_STATEMENTS_PER_CASE) throw new UploadRefused("upload_limit_reached");

  let result: ImportResult;
  let status: string;
  try {
    result = await processFile(data, fileType as "pdf" | "csv", caseRow.financial_year);
    status = result.status;
  } catch (error) {
    if (error instanceof ExtractorBusy) throw new UploadRefused("busy");
    console.error("statement processing failed", fileType, error instanceof Error ? error.name : typeof error);
    result = { ...rejectedFile(fileType as "pdf" | "csv", "unexpected_error") };
    status = "processing_failed";
  }

  if (status === REJECTED) {
    const upload = await insertUpload(db, firmId, caseId, { fileType, displayName, size: data.length, status,
      errorCode: result.errorCode });
    console.info("statement rejected", fileType, result.errorCode);
    return { upload, created: true };
  }

  const documentId = newId();
  const key = storageKey(firmId, caseId, documentId, fileType);
  await store.put(key, data, fileType === "pdf" ? "application/pdf" : "text/csv");
  try {
    const upload = await guarded(() => db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO documents (id, case_id, firm_id, kind, storage_key, display_name, content_type, size_bytes, sha256,
                                uploaded_by)
         VALUES ($1, $2, $3, 'bank_statement', $4, $5, $6, $7, $8, 'client')`,
        [documentId, caseId, firmId, key, displayName, fileType === "pdf" ? "application/pdf" : "text/csv", data.length,
          digest]);
      const row = await insertUpload(tx, firmId, caseId, { fileType, displayName, size: data.length, status, documentId,
        errorCode: status === "processing_failed" ? "unexpected_error" : result.errorCode,
        fields: status === "processing_failed" ? undefined : resultFields(result) });
      await tx.query(
        `UPDATE cases SET status = 'statement_uploaded', version = version + 1, updated_at = now()
         WHERE id = $1 AND firm_id = $2 AND status = 'draft'`, [caseId, firmId]);
      await recordAudit(tx, { actorKind: "client", actorId: input.actorId, firmId, caseId, action: "statement.uploaded",
        details: { upload_id: row.id, status } });
      await syncCaseStatus(tx, firmId, caseId); // a draft with outstanding requests becomes "documents_pending"
      return row;
    }), "statement_upload");
    console.info("statement stored", fileType, status, upload.rows_extracted, upload.rows_rejected);
    return { upload, created: true };
  } catch (error) {
    await store.remove(key).catch(() => undefined);
    if (error instanceof Conflict && error.code === "duplicate_document") {
      const again = await existingUploadForHash(db, firmId, caseId, digest); // a concurrent identical upload
      if (again) return { upload: again, created: false };
    }
    throw error;
  }
}

