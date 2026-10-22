import { getDb } from "@/lib/server/db";
import { apiRoute, json } from "@/lib/server/http";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";
import { uploadView } from "@/lib/server/views";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The firm's uploads, newest first, with their case and client first name.
export const GET = apiRoute(async (request) => {
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const rows = await db.query<Parameters<typeof uploadView>[0] & {
    case_reference: string; client_first_name: string; financial_year: string; profile_json: Record<string, unknown> }>(
    `SELECT u.*, c.reference AS case_reference, c.client_first_name, c.financial_year, c.profile_json
     FROM statement_uploads u JOIN cases c ON c.id = u.case_id AND c.firm_id = u.firm_id
     WHERE u.firm_id = $1 ORDER BY u.created_at DESC, u.id LIMIT 200`, [principal.firmId]);
  return json({
    statements: rows.map((u) => ({
      ...uploadView(u), case_reference: u.case_reference, client_first_name: u.client_first_name,
      financial_year: u.financial_year, bank_name: (u.profile_json?.bank_name as string | undefined) ?? null,
    })),
  });
});
