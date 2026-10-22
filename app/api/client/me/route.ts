import { canOpenCases, financialYearOptions, type CaseRow } from "@/lib/server/client-auth";
import { profileView } from "@/lib/server/client-profile";
import { clientChecklistView } from "@/lib/server/checklist";
import { getDb } from "@/lib/server/db";
import { apiRoute, json } from "@/lib/server/http";
import { clientPrincipal, clientUnauthenticated } from "@/lib/server/principals";
import { caseUploads, caseView, documentRequestViews, uploadLimits } from "@/lib/server/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request) => {
  const db = getDb();
  const principal = await clientPrincipal(request, db);
  if (!principal) return clientUnauthenticated();
  const [firm] = await db.query<{ name: string }>("SELECT name FROM firms WHERE id = $1", [principal.firmId]);
  const cases = await db.query<CaseRow>(
    "SELECT * FROM cases WHERE firm_id = $1 AND client_identity_id = $2 ORDER BY created_at",
    [principal.firmId, principal.clientIdentityId]);
  return json({
    client: { email: principal.email },
    firm: { name: firm.name },
    cases: await Promise.all(cases.map(async (c) => ({
      ...caseView(c),
      profile: profileView(c),
      statements: await caseUploads(db, principal.firmId, c.id),
      document_requests: await documentRequestViews(db, principal.firmId, c.id, false),
      checklist: c.status === "closed" ? [] : await clientChecklistView(db, principal.firmId, c.id),
    }))),
    upload_limits: uploadLimits(),
    financial_years: financialYearOptions(),
    can_open_case: await canOpenCases(db, principal),
    session: { idle_expires_at: principal.idleExpiresAt, absolute_expires_at: principal.absoluteExpiresAt },
  });
});
