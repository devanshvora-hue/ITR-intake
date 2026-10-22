import { z } from "zod";
import { caChecklistAction, caChecklistView, ChecklistRefused } from "@/lib/server/checklist";
import { getDb } from "@/lib/server/db";
import { Conflict } from "@/lib/server/errors";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { firmCaseByReference } from "@/lib/server/review";

export const runtime = "nodejs";

const Body = z.strictObject({ action: z.enum(["request", "dismiss", "restore"]) });

// The CA's decision on one suggestion. Only "request" creates a document
// request, through the same workflow as a CA-written request.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string; itemId: string }> }) => {
  const { reference, itemId } = await context.params;
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "checklist-firm", principal.firmId, limits.CHECKLIST_CHANGES_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many changes. Please try again later.");
  }
  try {
    const done = await caChecklistAction(db, { firmId: principal.firmId, caseRow: found, actorId: principal.userId, itemId,
      action: body.action });
    if (!done) return jsonError(404, "not_found", "Not found.");
  } catch (error) {
    if (error instanceof ChecklistRefused) return jsonError(409, error.code, "This suggestion cannot be changed this way.");
    if (error instanceof Conflict && error.code === "document_request_exists") {
      return jsonError(409, error.code, "A request for this document already exists.");
    }
    throw error;
  }
  return json({ checklist: await caChecklistView(db, principal.firmId, found.id) });
});
