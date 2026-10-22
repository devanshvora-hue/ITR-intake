import { rotateResumeCode } from "@/lib/server/client-entry";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { clientPrincipal, clientUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

// A new resume code for the signed-in client, shown once (the old code stops working).
export const POST = apiRoute(async (request) => {
  const db = getDb();
  const principal = await clientPrincipal(request, db);
  if (!principal) return clientUnauthenticated();
  if (!await withinLimit(db, "client-resume-rotate", principal.clientIdentityId, limits.CLIENT_RESUME_ATTEMPTS_PER_IDENTITY,
    HOUR)) {
    return jsonError(429, "rate_limited", "Too many attempts. Please try again later.");
  }
  return json({ resume_code: await rotateResumeCode(db, principal) });
});
