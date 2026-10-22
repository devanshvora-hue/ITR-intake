import { z } from "zod";
import { AuthenticationFailed, loginCa } from "@/lib/server/ca-auth";
import { readSessionToken, setSessionCookie } from "@/lib/server/cookies";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

const Body = z.strictObject({ email: z.string().max(254), password: z.string().max(256) });

export const POST = apiRoute(async (request) => {
  const { email, password } = await readJson(request, Body);
  try {
    const result = await loginCa(getDb(), email, password, readSessionToken(request, "ca"));
    return setSessionCookie(json({ status: "signed_in" }), "ca", result.token);
  } catch (error) {
    if (error instanceof AuthenticationFailed) return jsonError(401, "invalid_credentials", error.message);
    throw error;
  }
});
