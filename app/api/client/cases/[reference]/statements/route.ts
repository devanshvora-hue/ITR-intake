import { clientCaseByReference } from "@/lib/server/client-auth";
import { profileView } from "@/lib/server/client-profile";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { clientPrincipal, clientUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { handleStatementUpload, UploadRefused } from "@/lib/server/statements";
import { getFileStore } from "@/lib/server/storage";
import { MAX_PDF_BYTES, uploadView } from "@/lib/server/views";

export const runtime = "nodejs";
export const maxDuration = 60;

// The file is the raw request body; its name travels percent-encoded in
// X-Upload-Filename and is used for display only.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const db = getDb();
  const principal = await clientPrincipal(request, db);
  if (!principal) return clientUnauthenticated();
  const found = await clientCaseByReference(db, principal, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!profileView(found).complete) {
    return jsonError(409, "profile_required", "Please complete your profile before uploading a statement.");
  }
  if (!await withinLimit(db, "client-upload", principal.clientIdentityId, limits.CLIENT_UPLOADS_PER_CLIENT, HOUR)) {
    return jsonError(429, "rate_limited", "Too many uploads. Please try again later.");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PDF_BYTES)) {
    return jsonError(413, "file_too_large", "The file is too large.");
  }
  const data = new Uint8Array(await request.arrayBuffer());
  if (data.length > MAX_PDF_BYTES) return jsonError(413, "file_too_large", "The file is too large.");
  let filename = "";
  try {
    filename = decodeURIComponent(request.headers.get("x-upload-filename") ?? "").slice(0, 255);
  } catch {
    filename = "";
  }
  try {
    const outcome = await handleStatementUpload(db, getFileStore(), {
      firmId: principal.firmId, caseRow: found, actorId: principal.clientIdentityId, data, filename,
      contentType: request.headers.get("content-type") ?? "",
    });
    const view = uploadView(outcome.upload as Parameters<typeof uploadView>[0]);
    const status = view.status === "rejected" ? 422 : outcome.created ? 201 : 200;
    return json({ statement: view, created: outcome.created }, status);
  } catch (error) {
    if (error instanceof UploadRefused) {
      if (error.code === "busy") {
        return json({ error: "busy", message: "The server is busy reading other statements. Please try again shortly." },
          503, { "Retry-After": "30" });
      }
      return jsonError(409, "upload_limit_reached", "This case already has the maximum number of statements.");
    }
    throw error;
  }
});
