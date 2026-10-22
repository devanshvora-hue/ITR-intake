import { z } from "zod";
import { registerCa, RegistrationError } from "@/lib/server/ca-auth";
import { readSessionToken, setSessionCookie } from "@/lib/server/cookies";
import { getDb } from "@/lib/server/db";
import { apiRoute, clientAddress, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { HOUR, withinAll } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({
  full_name: z.string().min(1).max(200),
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(256),
  firm_name: z.string().min(1).max(200),
  contact_phone: z.string().max(40).nullish(),
  contact_address: z.string().max(500).nullish(),
  registration_number: z.string().max(64).nullish(),
});

const DUPLICATE_MESSAGES: Record<string, string> = {
  email_taken: "An account with this email address already exists. Sign in instead.",
  registration_number_taken: "A firm with this registration number is already registered.",
};

// Registration creates an active firm and owner and signs the owner in (201 with the CA session cookie). There is
// no e-mail verification or approval step. A duplicate e-mail or registration number is refused with 409; the
// per-address limit bounds how fast anyone can probe for existing accounts this way.
export const POST = apiRoute(async (request) => {
  const body = await readJson(request, Body);
  const db = getDb();
  const allowed = await withinAll(db, [
    ["register-peer", clientAddress(request), limits.CA_REGISTRATIONS_PER_ADDRESS, HOUR],
    ["register-all", "all", limits.CA_REGISTRATIONS_ALL, HOUR],
  ]);
  if (!allowed) return jsonError(429, "rate_limited", "Too many registrations from here. Try again later.");
  try {
    const registration = await registerCa(db, body, readSessionToken(request, "ca"));
    return setSessionCookie(json({ status: "registered" }, 201), "ca", registration.token);
  } catch (error) {
    if (error instanceof RegistrationError) {
      const duplicate = DUPLICATE_MESSAGES[error.code];
      if (duplicate) return jsonError(409, "already_registered", duplicate, { code: error.code });
      return jsonError(400, "invalid_registration", "Please check the highlighted details.", { code: error.code });
    }
    throw error;
  }
});
