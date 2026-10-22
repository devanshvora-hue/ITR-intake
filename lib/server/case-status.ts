// The case status that follows from its statement review and document
// requests. Called inside the transaction of every change that affects it.

import type { Db } from "./db";

// Statuses this workflow moves between. 'draft' (no statement yet), 'closed'
// and the unused intake statuses are left alone.
const MANAGED_STATUSES = ["statement_uploaded", "ca_review_required", "documents_pending", "review_ready"];

/**
 * Bring the case status in line with its documents, inside the caller's transaction:
 *   a required request is outstanding                  -> documents_pending
 *   otherwise, review prepared and requests were made  -> review_ready
 *   otherwise, review prepared                         -> ca_review_required
 *   otherwise                                          -> statement_uploaded
 * Returns the status after the call.
 */
export async function syncCaseStatus(tx: Db, firmId: string, caseId: string): Promise<string> {
  const [c] = await tx.query<{ status: string; reviewed_upload_id: string | null; outstanding: number; requests: number }>(
    `SELECT c.status, c.reviewed_upload_id,
            (SELECT count(*)::int FROM document_requests r WHERE r.case_id = c.id AND r.firm_id = c.firm_id
               AND r.required AND r.status = 'requested') AS outstanding,
            (SELECT count(*)::int FROM document_requests r WHERE r.case_id = c.id AND r.firm_id = c.firm_id) AS requests
     FROM cases c WHERE c.id = $1 AND c.firm_id = $2 FOR UPDATE`, [caseId, firmId]);
  if (!c || !MANAGED_STATUSES.includes(c.status)) return c?.status ?? "";
  const target = c.outstanding > 0 ? "documents_pending"
    : c.reviewed_upload_id !== null ? (c.requests > 0 ? "review_ready" : "ca_review_required")
    : "statement_uploaded";
  if (target !== c.status) {
    await tx.query("UPDATE cases SET status = $3, version = version + 1, updated_at = now() WHERE id = $1 AND firm_id = $2",
      [caseId, firmId, target]);
  }
  return target;
}
