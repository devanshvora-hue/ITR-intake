import { getDb } from "@/lib/server/db";
import { apiRoute, json } from "@/lib/server/http";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request) => {
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  const [firm] = await db.query<{ name: string; status: string }>("SELECT name, status FROM firms WHERE id = $1",
    [principal.firmId]);
  return json({
    user: { full_name: principal.fullName, email: principal.email, role: principal.role },
    firm: { name: firm.name, status: firm.status },
    session: { idle_expires_at: principal.idleExpiresAt, absolute_expires_at: principal.absoluteExpiresAt },
  });
});
