import { logoutClient } from "@/lib/server/client-auth";
import { clearSessionCookie, readSessionToken } from "@/lib/server/cookies";
import { getDb } from "@/lib/server/db";
import { apiRoute, json } from "@/lib/server/http";

export const runtime = "nodejs";

export const POST = apiRoute(async (request) => {
  const token = readSessionToken(request, "client");
  if (token) await logoutClient(getDb(), token);
  return clearSessionCookie(json({ status: "signed_out" }), "client");
});
