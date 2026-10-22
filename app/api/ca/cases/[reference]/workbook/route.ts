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
  // The reference is validated (IT-<LETTERS>-<6 chars>), so it is safe in a file name.
  return new Response(new Uint8Array(data), { headers: {
    "Content-Type": XLSX, "Content-Disposition": `attachment; filename="${found.reference}-internal-workbook.xlsx"`,
    "Cache-Control": "no-store",
  } });
});
