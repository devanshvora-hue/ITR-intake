import { z } from "zod";
import { EMAIL_VERIFICATION_TTL_S, pendingUnverifiedUser, startEmailVerification } from "@/lib/server/ca-auth";
import { getConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { canSendEmail, deliverAfterResponse, deliveryAnswer, queueEmail, TEMPLATE_VERIFY_EMAIL } from "@/lib/server/email";
import { apiRoute, json, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({ email: z.string().max(254) });

// Always the same 202, whether or not anything was sent.
export const POST = apiRoute(async (request) => {
  const { email } = await readJson(request, Body);
  const db = getDb();
  const answer = json(deliveryAnswer("verification_required"), 202);
  if (!await withinLimit(db, "resend-email", email.trim().toLowerCase(), limits.RESEND_VERIFICATION_PER_EMAIL, HOUR)) {
    return answer;
  }
  const user = await pendingUnverifiedUser(db, email);
  if (user && canSendEmail()) {
    const token = await startEmailVerification(db, user.id);
    const id = await queueEmail(db, {
      template: TEMPLATE_VERIFY_EMAIL, recipient: user.email, token,
      link: `${getConfig().appBaseUrl}/ca/verify-email#token=${token}`, ttlSeconds: EMAIL_VERIFICATION_TTL_S,
    });
    deliverAfterResponse(db, [id]);
  }
  return answer;
});
