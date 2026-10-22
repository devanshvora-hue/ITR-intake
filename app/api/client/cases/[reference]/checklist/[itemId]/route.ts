import { z } from "zod";
import { ChecklistRefused, clientChecklistView, setClientResponse } from "@/lib/server/checklist";
import { clientCaseByReference } from "@/lib/server/client-auth";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { clientPrincipal, clientUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({
  response: z.enum(["unavailable", "not_applicable"]).nullable(),
  note: z.string().max(1000).nullish(),
});

// The client's answer to one open suggestion of their own case, or null to clear it.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string; itemId: string }> }) => {
  const { reference, itemId } = await context.params;
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await clientPrincipal(request, db);
  if (!principal) return clientUnauthenticated();
  const found = await clientCaseByReference(db, principal, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "client-checklist", principal.clientIdentityId, limits.CLIENT_CHECKLIST_RESPONSES_PER_CLIENT,
    HOUR)) {
    return jsonError(429, "rate_limited", "Too many attempts. Please try again later.");
  }
  try {
    const done = await setClientResponse(db, { firmId: principal.firmId, caseRow: found, actorId: principal.clientIdentityId,
      itemId, response: body.response, note: body.note });
    if (!done) return jsonError(404, "not_found", "Not found.");
  } catch (error) {
    if (error instanceof ChecklistRefused) {
      if (error.code === "invalid_note") {
        return jsonError(400, "invalid_request", "Please check the note (up to 300 characters).", { fields: ["note"] });
      }
      return jsonError(409, error.code, "This suggestion cannot be answered now.");
    }
    throw error;
  }
  return json({ checklist: await clientChecklistView(db, principal.firmId, found.id) });
});
