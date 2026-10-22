import { z } from "zod";
import { DecisionRefused, decideRow } from "@/lib/server/corrections";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { firmCaseByReference, reviewView } from "@/lib/server/review";

export const runtime = "nodejs";

const Body = z.strictObject({
  /** A category to confirm or set, or null to return to the classifier's category. */
  category: z.string().max(80).nullable(),
  note: z.string().max(1000).nullish(),
});

const MESSAGES: Record<DecisionRefused["code"], [number, string]> = {
  no_review: [409, "Prepare the review first."],
  row_not_found: [404, "Not found."],
  row_not_valid: [409, "This row could not be read, so it cannot be classified."],
  case_closed: [409, "This case is closed."],
  invalid_category: [400, "Choose one of the listed categories."],
  invalid_note: [400, "Please keep the note under 300 characters."],
};

// The CA's decision on one row of the current review. The extracted row is never changed.
export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string; rowNumber: string }> }) => {
  const { reference, rowNumber } = await context.params;
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const found = await firmCaseByReference(db, principal.firmId, reference);
  const row = /^[1-9]\d{0,5}$/.test(rowNumber) ? Number(rowNumber) : null;
  if (!found || row === null) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "classification-firm", principal.firmId, limits.CLASSIFICATION_DECISIONS_PER_FIRM, HOUR)) {
    return jsonError(429, "rate_limited", "Too many changes. Please try again later.");
  }
  try {
    await decideRow(db, { firmId: principal.firmId, caseRow: found, actorId: principal.userId, rowNumber: row,
      category: body.category, note: body.note });
  } catch (error) {
    if (error instanceof DecisionRefused) {
      const [status, message] = MESSAGES[error.code];
      return jsonError(status, error.code, message);
    }
    throw error;
  }
  const review = await reviewView(db, principal.firmId, found);
  return json({ row: review?.rows.find((r) => r.row_number === row) ?? null, totals: review?.totals ?? null });
});
