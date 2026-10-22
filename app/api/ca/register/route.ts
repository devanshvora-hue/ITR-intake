import { z } from "zod";
import { registerCa, RegistrationError, startEmailVerification, EMAIL_VERIFICATION_TTL_S } from "@/lib/server/ca-auth";
import { getConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { canSendEmail, deliverAfterResponse, deliveryAnswer, queueEmail, TEMPLATE_VERIFY_EMAIL } from "@/lib/server/email";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";

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

// Registration always answers 202 the same way, also for a duplicate e-mail or
// registration number (no account enumeration).
export const POST = apiRoute(async (request) => {
  const body = await readJson(request, Body);
  const db = getDb();
  let registration;
  try {
    registration = await registerCa(db, body);
  } catch (error) {
    if (error instanceof RegistrationError) {
      if (error.code === "email_taken" || error.code === "registration_number_taken") {
        return json(deliveryAnswer("verification_required"), 202);
      }
      return jsonError(400, "invalid_registration", "Please check the highlighted details.", { code: error.code });
    }
    throw error;
  }
  const token = await startEmailVerification(db, registration.userId);
  if (!canSendEmail()) return json(deliveryAnswer("verification_required"), 202);
  const id = await queueEmail(db, {
    template: TEMPLATE_VERIFY_EMAIL, recipient: registration.email, token, firmId: registration.firmId,
    link: `${getConfig().appBaseUrl}/ca/verify-email#token=${token}`, ttlSeconds: EMAIL_VERIFICATION_TTL_S,
  });
  deliverAfterResponse(db, [id]);
  return json(deliveryAnswer("verification_required"), 202);
});
