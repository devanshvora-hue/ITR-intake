// The CA case-detail response (port of app._ca_case_detail): case, profile,
// statement uploads, the stored review, document requests and the suggested checklist.

import { profileView } from "./client-profile";
import { caChecklistView } from "./checklist";
import type { Db } from "./db";
import { intakeProgress } from "./intake";
import { readinessView } from "./readiness";
import { reviewView, type ReviewCase } from "./review";
import { caseUploads, documentRequestViews } from "./views";

export async function caseDetail(db: Db, firmId: string,
  c: ReviewCase & { client_email: string; client_email_verified: boolean }) {
  return {
    case: { reference: c.reference, financial_year: c.financial_year, status: c.status, created_at: c.created_at,
      updated_at: c.updated_at, client_first_name: c.client_first_name, client_email: c.client_email,
      client_email_verified: c.client_email_verified, reviewed_at: c.reviewed_at },
    intake: await intakeProgress(db, firmId, c),
    readiness: await readinessView(db, firmId, c),
    profile: profileView(c),
    statements: await caseUploads(db, firmId, c.id),
    review: await reviewView(db, firmId, c),
    document_requests: await documentRequestViews(db, firmId, c.id, true),
    checklist: await caChecklistView(db, firmId, c.id),
  };
}
