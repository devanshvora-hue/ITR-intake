import { logoutCa } from "@/lib/server/ca-auth";
import { clearSessionCookie, readSessionToken } from "@/lib/server/cookies";
import { getDb } from "@/lib/server/db";
import { apiRoute, json } from "@/lib/server/http";

export const runtime = "nodejs";

export const POST = apiRoute(async (request) => {
  const token = readSessionToken(request, "ca");
  if (token) await logoutCa(getDb(), token);
  return clearSessionCookie(json({ status: "signed_out" }), "ca");
});
