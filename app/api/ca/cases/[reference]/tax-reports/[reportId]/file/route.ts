import { getDb } from "@/lib/server/db";
import { apiRoute, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { firmCaseByReference } from "@/lib/server/review";
import { getFileStore } from "@/lib/server/storage";
import { loadTaxReportFile } from "@/lib/server/tax-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The original uploaded report file, through the server (never a storage URL); the name is server-generated.
export const GET = apiRoute(async (request, context: { params: Promise<{ reference: string; reportId: string }> }) => {
  const { reference, reportId } = await context.params;
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "document-download-firm", principal.firmId, limits.DOCUMENT_DOWNLOADS_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many downloads. Please try again later.");
  }
  const file = await loadTaxReportFile(db, getFileStore(), { firmId: principal.firmId, caseId: found.id, reportId,
    actorId: principal.userId });
  if (!file) return jsonError(404, "not_found", "Not found.");
  return new Response(new Uint8Array(file.data), { headers: {
    "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.filename}"`,
    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox",
  } });
});
