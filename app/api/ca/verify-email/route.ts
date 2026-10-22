import { z } from "zod";
import { confirmEmail, VerificationFailed } from "@/lib/server/ca-auth";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

const Body = z.strictObject({ token: z.string().max(200) });

export const POST = apiRoute(async (request) => {
  const { token } = await readJson(request, Body);
  try {
    await confirmEmail(getDb(), token);
  } catch (error) {
    if (error instanceof VerificationFailed) {
      return jsonError(400, "verification_failed", "This verification link is invalid or has expired.");
    }
    throw error;
  }
  return json({ status: "email_verified", next: "awaiting_approval" });
});
