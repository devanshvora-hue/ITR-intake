import { clientCaseByReference } from "@/lib/server/client-auth";
import { getDb } from "@/lib/server/db";
import { DocumentRefused, documentView, handleDocumentUpload, MAX_DOCUMENT_BYTES } from "@/lib/server/documents";
import { apiRoute, json, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { clientPrincipal, clientUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { getFileStore } from "@/lib/server/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

const CONFLICTS = new Set(["case_closed", "request_waived", "file_limit_reached", "already_uploaded_for_another_request"]);

// A supporting document for one request of the client's own case. The file is
// the raw request body; its name travels percent-encoded in X-Upload-Filename
// and is used for display only.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string; requestId: string }> }) => {
  const { reference, requestId } = await context.params;
  const db = getDb();
  const principal = await clientPrincipal(request, db);
  if (!principal) return clientUnauthenticated();
  const found = await clientCaseByReference(db, principal, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "client-document-upload", principal.clientIdentityId,
    limits.CLIENT_DOCUMENT_UPLOADS_PER_CLIENT, HOUR)) {
    return jsonError(429, "rate_limited", "Too many uploads. Please try again later.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_DOCUMENT_BYTES)) {
    return jsonError(413, "file_too_large", "The file is too large.");
  }
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length > MAX_DOCUMENT_BYTES) return jsonError(413, "file_too_large", "The file is too large.");
  let filename = "";
  try {
    filename = decodeURIComponent(request.headers.get("x-upload-filename") ?? "").slice(0, 255);
  } catch {
    filename = "";
  }
  try {
    const outcome = await handleDocumentUpload(db, getFileStore(), { firmId: principal.firmId, caseRow: found, requestId,
      actorId: principal.clientIdentityId, data, filename, contentType: request.headers.get("content-type") ?? "" });
    if (!outcome) return jsonError(404, "not_found", "Not found.");
    return json({ document: documentView(outcome.document), created: outcome.created }, outcome.created ? 201 : 200);
  } catch (error) {
    if (error instanceof DocumentRefused) {
      return jsonError(CONFLICTS.has(error.code) ? 409 : 422, error.code, "This file cannot be accepted.");
    }
    throw error;
  }
});
