import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { caseTaxReconciliation, firmCaseByReference } from "@/lib/server/review";
import { TaxReportRefused, withdrawTaxReport } from "@/lib/server/tax-reports";

export const runtime = "nodejs";

// Take a wrongly uploaded report out of the reconciliation (its file and records stay on record).
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string; reportId: string }> }) => {
  const { reference, reportId } = await context.params;
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "tax-report-change-firm", principal.firmId, limits.TAX_REPORT_CHANGES_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many changes. Please try again later.");
  }
  try {
    if (!await withdrawTaxReport(db, { firmId: principal.firmId, caseRow: found, actorId: principal.userId, reportId })) {
      return jsonError(404, "not_found", "Not found.");
    }
  } catch (error) {
    if (error instanceof TaxReportRefused) return jsonError(409, error.code, "This case is closed.");
    throw error;
  }
  return json({ tax_reconciliation: await caseTaxReconciliation(db, principal.firmId, found) });
});
