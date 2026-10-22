import { caChecklistView, refreshChecklist } from "@/lib/server/checklist";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { firmCaseByReference } from "@/lib/server/review";

export const runtime = "nodejs";

// Recompute the case's suggested checklist from its current profile and review
// (it also refreshes on its own when either changes). Creates no requests.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (found.status === "closed") return jsonError(409, "case_closed", "This case is closed.");
  if (!await withinLimit(db, "checklist-firm", principal.firmId, limits.CHECKLIST_CHANGES_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many changes. Please try again later.");
  }
  await refreshChecklist(db, principal.firmId, found.id);
  return json({ checklist: await caChecklistView(db, principal.firmId, found.id) });
});
