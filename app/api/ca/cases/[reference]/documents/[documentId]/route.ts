import { getDb } from "@/lib/server/db";
import { loadSupportingFile } from "@/lib/server/documents";
import { apiRoute, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { firmCaseByReference } from "@/lib/server/review";
import { getFileStore } from "@/lib/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One supporting document of a case of the CA's firm, sent through the server
// (never a storage URL). The download name is server-generated
// (<document id>.<ext>); the client's file name is never put in a header.
export const GET = apiRoute(async (request, context: { params: Promise<{ reference: string; documentId: string }> }) => {
  const { reference, documentId } = await context.params;
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "document-download-firm", principal.firmId, limits.DOCUMENT_DOWNLOADS_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many downloads. Please try again later.");
  }
  const loaded = await loadSupportingFile(db, getFileStore(), { firmId: principal.firmId, caseRow: found, documentId,
    actorId: principal.userId });
  if (!loaded) return jsonError(404, "not_found", "Not found.");
  const { document, data } = loaded;
  const filename = `${document.id}.${document.storage_key.split(".").pop()}`;
  return new Response(new Uint8Array(data), { headers: {
    "Content-Type": document.content_type, "Content-Disposition": `attachment; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox",
  } });
});
