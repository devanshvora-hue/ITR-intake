import { caseDetail } from "@/lib/server/case-detail";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError } from "@/lib/server/http";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { firmCaseByReference } from "@/lib/server/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The case is found by reference within the signed-in CA's firm only.
export const GET = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  return json(await caseDetail(db, principal.firmId, found));
});
