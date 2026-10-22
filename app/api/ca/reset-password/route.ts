import { z } from "zod";
import { confirmPasswordReset, PasswordResetFailed } from "@/lib/server/ca-auth";
import { clearSessionCookie } from "@/lib/server/cookies";
import { getDb } from "@/lib/server/db";
import { apiRoute, clientAddress, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { PasswordPolicyError } from "@/lib/server/passwords";
import { HOUR, withinAll } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({ token: z.string().max(200), new_password: z.string().max(256) });

export const POST = apiRoute(async (request) => {
  const body = await readJson(request, Body);
  const db = getDb();
  if (!await withinAll(db, [
    ["reset-confirm-peer", clientAddress(request), limits.RESET_ATTEMPTS_PER_ADDRESS, HOUR],
    ["reset-confirm-all", "all", limits.RESET_ATTEMPTS_ALL, HOUR],
  ])) {
    return jsonError(429, "rate_limited", "Too many attempts. Please try again later.");
  }
  try {
    await confirmPasswordReset(db, body.token, body.new_password);
  } catch (error) {
    if (error instanceof PasswordResetFailed) return jsonError(400, "reset_failed", "This reset link is invalid or has expired.");
    if (error instanceof PasswordPolicyError) {
      return jsonError(400, "invalid_password", "Please choose a stronger password.", { code: error.code });
    }
    throw error;
  }
  // Every session of the account was revoked.
  return clearSessionCookie(json({ status: "password_reset" }), "ca");
});
