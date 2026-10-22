import { z } from "zod";
import { caseDetail } from "@/lib/server/case-detail";
import { getDb } from "@/lib/server/db";
import { Conflict } from "@/lib/server/errors";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { isId } from "@/lib/server/ids";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { ExtractorBusy, firmCaseByReference, prepareReview, ReviewRefused } from "@/lib/server/review";
import { getFileStore } from "@/lib/server/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.strictObject({ statement_id: z.string().max(36) });

// Prepare (or re-prepare) the case's review from one of its stored statements.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  if (!found || !isId(body.statement_id)) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "case-review-firm", principal.firmId, limits.CASE_REVIEWS_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many review preparations. Please try again later.");
  }
  try {
    await prepareReview(db, getFileStore(), { firmId: principal.firmId, caseRow: found, uploadId: body.statement_id,
      actorId: principal.userId });
  } catch (error) {
    if (error instanceof ReviewRefused) {
      if (error.code === "not_found") return jsonError(404, "not_found", "Not found.");
      return jsonError(409, error.code, "This statement cannot be prepared for review.");
    }
    if (error instanceof Conflict && error.code === "stale_version") {
      return jsonError(409, "stale_version", "The case changed meanwhile. Please reload and try again.");
    }
    if (error instanceof ExtractorBusy) {
      return json({ error: "busy", message: "The server is busy reading other statements. Please try again shortly." },
        503, { "Retry-After": "30" });
    }
    throw error;
  }
  const updated = await firmCaseByReference(db, principal.firmId, reference);
  return json(await caseDetail(db, principal.firmId, updated!));
});
