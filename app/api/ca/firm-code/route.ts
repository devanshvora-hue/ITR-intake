import { getDb } from "@/lib/server/db";
import { firmCodeChange } from "@/lib/server/firm-code-route";
import { ensureFirmCode, firmCodeState } from "@/lib/server/firm-codes";
import { apiRoute, json } from "@/lib/server/http";
import { caPrincipal, caUnauthenticated } from "@/lib/server/principals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiRoute(async (request) => {
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  return json(await firmCodeState(db, principal));
});

export const POST = apiRoute((request) => firmCodeChange(request, async (db, principal) => {
  const { view, created } = await ensureFirmCode(db, principal);
  return json({ firm_code: view, created }, created ? 201 : 200);
}));
