import { z } from "zod";
import { VerificationFailed } from "@/lib/server/ca-auth";
import { logoutClient, verifyClient } from "@/lib/server/client-auth";
import { readSessionToken, setSessionCookie } from "@/lib/server/cookies";
import { getDb } from "@/lib/server/db";
import { apiRoute, clientAddress, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { HOUR, withinAll } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({ token: z.string().max(200) });

export const POST = apiRoute(async (request) => {
  const { token } = await readJson(request, Body);
  const db = getDb();
  if (!await withinAll(db, [
    ["client-verify-peer", clientAddress(request), limits.CLIENT_VERIFY_PER_ADDRESS, HOUR],
    ["client-verify-all", "all", limits.CLIENT_VERIFY_ALL, HOUR],
  ])) {
    return jsonError(429, "rate_limited", "Too many attempts. Please try again later.");
  }
  let result;
  try {
    result = await verifyClient(db, token);
  } catch (error) {
    if (error instanceof VerificationFailed) {
      return jsonError(400, "verification_failed", "This link is invalid or has expired. Please start again.");
    }
    throw error;
  }
  const previous = readSessionToken(request, "client");
  if (previous) await logoutClient(db, previous); // rotation: a presented older session ends
  return setSessionCookie(json({ status: "signed_in" }), "client", result.token);
});
