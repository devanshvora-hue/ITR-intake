import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { caseTaxReconciliation, firmCaseByReference } from "@/lib/server/review";
import { reviewTaxRecord, TaxReportRefused } from "@/lib/server/tax-reports";

export const runtime = "nodejs";

const Body = z.strictObject({
  status: z.enum(["confirmed", "unresolved"]).nullable(),
  note: z.string().max(1000).nullish(),
  /** The match the CA is looking at (from the view); the verdict applies only while it is unchanged. */
  signature: z.string().max(2000).nullish(),
});

// The CA's verdict on one report entry: confirmed, unresolved, or null to clear it.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string; recordId: string }> }) => {
  const { reference, recordId } = await context.params;
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "tax-report-change-firm", principal.firmId, limits.TAX_REPORT_CHANGES_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many changes. Please try again later.");
  }
  try {
    const done = await reviewTaxRecord(db, { firmId: principal.firmId, caseRow: found, actorId: principal.userId, recordId,
      status: body.status, note: body.note, signature: body.signature });
    if (!done) return jsonError(404, "not_found", "Not found.");
  } catch (error) {
    if (error instanceof TaxReportRefused) {
      const messages: Record<string, string> = { case_closed: "This case is closed.",
        invalid_note: "Please keep the note under 300 characters.", invalid_signature: "Reload the page and try again." };
      return jsonError(error.code === "case_closed" ? 409 : 400, error.code, messages[error.code] ?? "Please try again.");
    }
    throw error;
  }
  return json({ tax_reconciliation: await caseTaxReconciliation(db, principal.firmId, found) });
});
