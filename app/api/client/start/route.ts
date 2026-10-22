import { z } from "zod";
import { logoutClient } from "@/lib/server/client-auth";
import { EntryRefused, enterClient } from "@/lib/server/client-entry";
import { readSessionToken, setSessionCookie } from "@/lib/server/cookies";
import { getDb } from "@/lib/server/db";
import { apiRoute, clientAddress, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { HOUR, limitReached, withinAll, withinLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({
  firm_code: z.string().max(64),
  email: z.string().max(254),
  resume_code: z.string().max(64).nullish(),
});

const MESSAGES: Record<EntryRefused["code"], [number, string]> = {
  invalid_email: [400, "Please enter a valid email address."],
  invalid_firm_code: [400, "This firm code is not recognised. Please check it with your CA."],
  resume_code_required: [409, "This email already has an intake with this firm. Enter your resume code to continue."],
  resume_code_invalid: [400, "This resume code is not correct."],
  rate_limited: [429, "Too many attempts. Please try again later."],
};

// Direct entry with firm code + e-mail (see lib/server/client-entry.ts for the
// reduced identity assurance). Signs the client in; no e-mail is sent.
export const POST = apiRoute(async (request) => {
  const body = await readJson(request, Body);
  const db = getDb();
  const address = clientAddress(request);
  if (!await withinAll(db, [
    ["client-start-peer", address, limits.CLIENT_STARTS_PER_ADDRESS, HOUR],
    ["client-start-all", "all", limits.CLIENT_STARTS_ALL, HOUR],
  ]) || await limitReached(db, "client-bad-code-peer", address, limits.CLIENT_BAD_CODES_PER_ADDRESS, HOUR)) {
    return jsonError(429, "rate_limited", MESSAGES.rate_limited[1]);
  }
  const presented = readSessionToken(request, "client");
  let result;
  try {
    result = await enterClient(db, { firmCode: body.firm_code, email: body.email, resumeCode: body.resume_code,
      presentedToken: presented });
  } catch (error) {
    if (!(error instanceof EntryRefused)) throw error;
    if (error.code === "invalid_firm_code") {
      await withinLimit(db, "client-bad-code-peer", address, limits.CLIENT_BAD_CODES_PER_ADDRESS, HOUR);
    }
    const [status, message] = MESSAGES[error.code];
    return jsonError(status, error.code, message);
  }
  const answer = json({ status: "signed_in", created: result.created, resume_code: result.resumeCode });
  if (!result.token) return answer;
  if (presented) await logoutClient(db, presented); // another client's (or an expired) session in this browser ends
  return setSessionCookie(answer, "client", result.token);
});
