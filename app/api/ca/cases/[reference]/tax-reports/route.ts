import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { caseTaxReconciliation, firmCaseByReference } from "@/lib/server/review";
import { getFileStore } from "@/lib/server/storage";
import { MAX_TAX_REPORT_BYTES, TaxReportRefused, uploadTaxReport } from "@/lib/server/tax-reports";

export const runtime = "nodejs";
export const maxDuration = 60;

const MESSAGES: Record<string, string> = {
  case_closed: "This case is closed.",
  invalid_kind: "Choose whether the file is an AIS, TIS or Form 26AS.",
  file_too_large: "The file is larger than 4 MB.",
  empty_file: "The file is empty.",
  pdf_not_supported: "PDF reports are not read in this version (portal PDFs are password-protected). Upload the report as CSV or Excel (.xlsx).",
  json_not_supported: "JSON reports are not read in this version. Upload the report as CSV or Excel (.xlsx).",
  xls_not_supported: "Old Excel (.xls) files are not read. Save the file as .xlsx or CSV and upload it again.",
  unsupported_file_type: "Only CSV and Excel (.xlsx) reports are accepted.",
  type_mismatch: "The file's contents do not match its name.",
  unreadable_file: "The file could not be read. Check that it is a valid .xlsx file.",
  unsupported_encoding: "Save the CSV as UTF-8 text and upload it again.",
  malformed_csv: "The CSV is not well formed (for example, an unclosed quote).",
  missing_required_columns: "No table with an amount column and a description, category or section column was found.",
  no_records: "The report has no readable entries.",
  too_many_rows: "The report has too many rows.",
  already_uploaded: "This file was already uploaded for this case.",
};

// Upload an AIS / TIS / Form 26AS report (raw body; kind in the query, name in X-Upload-Filename). Refused files
// are never stored: the answer names the reason.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "tax-report-upload-firm", principal.firmId, limits.TAX_REPORT_UPLOADS_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many uploads. Please try again later.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_TAX_REPORT_BYTES)) {
    return jsonError(413, "file_too_large", MESSAGES.file_too_large);
  }
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length > MAX_TAX_REPORT_BYTES) return jsonError(413, "file_too_large", MESSAGES.file_too_large);
  let filename = "";
  try {
    filename = decodeURIComponent(request.headers.get("x-upload-filename") ?? "").slice(0, 255);
  } catch {
    filename = "";
  }
  try {
    const result = await uploadTaxReport(db, getFileStore(), { firmId: principal.firmId, caseRow: found, actorId: principal.userId,
      kind: new URL(request.url).searchParams.get("kind"), data, filename });
    return json({ report: result, tax_reconciliation: await caseTaxReconciliation(db, principal.firmId, found) }, 201);
  } catch (error) {
    if (error instanceof TaxReportRefused) {
      const status = error.code === "case_closed" || error.code === "already_uploaded" ? 409 : 422;
      return jsonError(status, error.code, MESSAGES[error.code] ?? "This file cannot be accepted.");
    }
    throw error;
  }
});
