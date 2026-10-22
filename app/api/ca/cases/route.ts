import type { CaseRow } from "@/lib/server/client-auth";
import { profileView } from "@/lib/server/client-profile";
import { getDb } from "@/lib/server/db";
import { apiRoute, json } from "@/lib/server/http";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { readinessView } from "@/lib/server/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The firm's cases, most recently updated first, with rule-based readiness facts.
export const GET = apiRoute(async (request) => {
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const rows = await db.query<CaseRow & { client_email: string; opening_balance: string | null; closing_balance: string | null }>(
    `SELECT c.*, c.opening_balance::text AS opening_balance, c.closing_balance::text AS closing_balance,
            i.email_norm AS client_email
     FROM cases c JOIN client_identities i ON i.id = c.client_identity_id AND i.firm_id = c.firm_id
     WHERE c.firm_id = $1 ORDER BY c.updated_at DESC`, [principal.firmId]);
  return json({
    cases: await Promise.all(rows.map(async (c) => ({
      reference: c.reference, financial_year: c.financial_year, status: c.status, updated_at: c.updated_at,
      created_at: c.created_at, client_first_name: c.client_first_name, client_email: c.client_email,
      profile: profileView(c), readiness: await readinessView(db, principal.firmId, c),
    }))),
  });
});
