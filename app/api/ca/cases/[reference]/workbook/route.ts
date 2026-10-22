import { recordAudit } from "@/lib/server/audit";
import { getDb } from "@/lib/server/db";
import { apiRoute, errorReference, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { buildCaseWorkbook, firmCaseByReference, NoReview } from "@/lib/server/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** [Bank]_[Name]_ITR_Summary_FY[YYYY-YY].xlsx (specification H), letters and digits only so it is safe in a header. */
function workbookFileName(c: { profile_json: Record<string, unknown>; client_first_name: string; financial_year: string }) {
  const part = (value: unknown, fallback: string) =>
    (typeof value === "string" ? value : "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "").slice(0, 30) || fallback;
  const profile = c.profile_json ?? {};
  return `${part(profile.bank_name, "Bank")}_${part(profile.full_name, part(c.client_first_name, "Client"))}`
    + `_ITR_Summary_FY${c.financial_year}.xlsx`;
}

// The internal workbook for the case's current review (CA only, never cached).
export const GET = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "workbook-firm", principal.firmId, limits.WORKBOOKS_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many workbook downloads. Please try again later.");
  }
  let data: Uint8Array;
  try {
    data = await buildCaseWorkbook(db, principal.firmId, found);
  } catch (error) {
    if (error instanceof NoReview) return jsonError(404, "no_review", "This case has no prepared review yet.");
    console.error("workbook generation failed", errorReference(error)); // never row data or paths
    return jsonError(500, "workbook_failed", "The workbook could not be generated.");
  }
  await recordAudit(db, { actorKind: "ca", actorId: principal.userId, firmId: principal.firmId, caseId: found.id,
    action: "case.workbook_downloaded" });
  return new Response(new Uint8Array(data), { headers: {
    "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${workbookFileName(found)}"`,
    "Cache-Control": "no-store",
  } });
});
