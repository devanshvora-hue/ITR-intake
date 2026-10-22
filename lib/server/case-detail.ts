// The CA case-detail response (port of app._ca_case_detail): case, profile,
// statement uploads, the stored review and document requests.

import { profileView } from "./client-profile";
import type { Db } from "./db";
import { reviewView, type ReviewCase } from "./review";
import { caseUploads, documentRequestViews } from "./views";

export async function caseDetail(db: Db, firmId: string, c: ReviewCase & { client_email: string }) {
  return {
    case: { reference: c.reference, financial_year: c.financial_year, status: c.status, created_at: c.created_at,
      updated_at: c.updated_at, client_first_name: c.client_first_name, client_email: c.client_email },
    profile: profileView(c),
    statements: await caseUploads(db, firmId, c.id),
    review: await reviewView(db, firmId, c),
    document_requests: await documentRequestViews(db, firmId, c.id, true),
  };
}
