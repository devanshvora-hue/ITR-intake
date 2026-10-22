import { z } from "zod";
import { getDb } from "@/lib/server/db";
import { createRequest, DocumentRefused, RequestInvalid, requestView } from "@/lib/server/documents";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { firmCaseByReference } from "@/lib/server/review";

export const runtime = "nodejs";

const Body = z.strictObject({
  label: z.string().max(200),
  description: z.string().max(1000).nullable().optional(),
  required: z.boolean().default(true),
});

// Ask the client for a supporting document on a case of the CA's firm.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "document-request-firm", principal.firmId, limits.DOCUMENT_REQUESTS_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many document requests. Please try again later.");
  }
  try {
    const created = await createRequest(db, { firmId: principal.firmId, caseRow: found, actorId: principal.userId,
      label: body.label, description: body.description, required: body.required });
    return json({ request: await requestView(db, principal.firmId, created, true) }, 201);
  } catch (error) {
    if (error instanceof RequestInvalid) {
      return jsonError(400, "invalid_request", "Please check the highlighted details.", { fields: error.fields });
    }
    if (error instanceof DocumentRefused) return jsonError(409, error.code, "Documents cannot be requested for this case.");
    throw error;
  }
});
