// Shared handler for the CA waive / reopen routes (like firm-code-route.ts).

import { getDb } from "./db";
import { changeRequestStatus, DocumentRefused, requestView } from "./documents";
import { apiRoute, json, jsonError } from "./http";
import { limits } from "./limits";
import { caPrincipal, caUnauthenticated } from "./principals";
import { HOUR, withinLimit } from "./rate-limit";
import { firmCaseByReference } from "./review";

type Params = { params: Promise<{ reference: string; requestId: string }> };

/** A POST handler that waives or reopens one request on a case of the CA's firm. */
export function documentStatusRoute(action: "waive" | "reopen") {
  return apiRoute(async (request, context: Params) => {
    const { reference, requestId } = await context.params;
    const db = getDb();
    const principal = await caPrincipal(request, db);
    if (!principal) return caUnauthenticated();
    const found = await firmCaseByReference(db, principal.firmId, reference);
    if (!found) return jsonError(404, "not_found", "Not found.");
    if (!await withinLimit(db, "document-status-firm", principal.firmId, limits.DOCUMENT_STATUS_CHANGES_PER_FIRM, HOUR)) {
      return jsonError(429, "rate_limited", "Too many changes. Please try again later.");
    }
    try {
      const updated = await changeRequestStatus(db, { firmId: principal.firmId, caseRow: found, actorId: principal.userId,
        requestId, action });
      if (!updated) return jsonError(404, "not_found", "Not found.");
      return json({ request: await requestView(db, principal.firmId, updated, true) });
    } catch (error) {
      if (error instanceof DocumentRefused) return jsonError(409, error.code, "This request cannot be changed this way.");
      throw error;
    }
  });
}
