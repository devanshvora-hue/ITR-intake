// Intake progress for one case, computed from stored data only (never from
// the browser): the client's details, a usable bank statement, and every
// required document request answered (received, or waived by the CA). A step
// is never marked done when its data is missing. Read-only.

import { profileView } from "./client-profile";
import type { CaseRow } from "./client-auth";
import type { Db } from "./db";
import { PREPARABLE_UPLOAD_STATUSES } from "./readiness";

export type IntakeStep = { key: "details" | "statement" | "documents"; done: boolean; outstanding?: number };

export async function intakeProgress(db: Db, firmId: string, caseRow: Pick<CaseRow, "id" | "profile_json">) {
  const [counts] = await db.query<{ statements: number; outstanding: number; last_upload: Date | null }>(
    `SELECT (SELECT count(*)::int FROM statement_uploads u WHERE u.case_id = $1 AND u.firm_id = $2
               AND u.document_id IS NOT NULL AND u.status = ANY($3::text[])) AS statements,
            (SELECT count(*)::int FROM document_requests r WHERE r.case_id = $1 AND r.firm_id = $2
               AND r.required AND r.status = 'requested') AS outstanding,
            (SELECT max(d.created_at) FROM documents d WHERE d.case_id = $1 AND d.firm_id = $2
               AND d.uploaded_by = 'client') AS last_upload`,
    [caseRow.id, firmId, PREPARABLE_UPLOAD_STATUSES]);
  const steps: IntakeStep[] = [
    { key: "details", done: profileView(caseRow).complete },
    { key: "statement", done: counts.statements > 0 },
    { key: "documents", done: counts.outstanding === 0, outstanding: counts.outstanding },
  ];
  return { steps, complete: steps.every((s) => s.done), last_client_upload_at: counts.last_upload };
}
