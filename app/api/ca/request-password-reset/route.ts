import { z } from "zod";
import { PASSWORD_RESET_TTL_S, requestPasswordReset } from "@/lib/server/ca-auth";
import { getConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { canSendEmail, deliverAfterResponse, deliveryAnswer, queueEmail, TEMPLATE_PASSWORD_RESET } from "@/lib/server/email";
import { apiRoute, clientAddress, json, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { HOUR, withinAll } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({ email: z.string().max(254) });

// Always the same 202, whether or not the account exists, mail was sent or a limit was hit.
export const POST = apiRoute(async (request) => {
  const { email } = await readJson(request, Body);
  const db = getDb();
  const allowed = await withinAll(db, [
    ["reset-email", email.trim().toLowerCase(), limits.RESET_REQUESTS_PER_EMAIL, HOUR],
    ["reset-peer", clientAddress(request), limits.RESET_REQUESTS_PER_ADDRESS, HOUR],
    ["reset-all", "all", limits.RESET_REQUESTS_ALL, HOUR],
  ]);
  if (allowed && canSendEmail()) {
    const result = await requestPasswordReset(db, email);
    if (result) {
      const id = await queueEmail(db, {
        template: TEMPLATE_PASSWORD_RESET, recipient: result.email, token: result.token,
        link: `${getConfig().appBaseUrl}/ca/reset-password#token=${result.token}`, ttlSeconds: PASSWORD_RESET_TTL_S,
      });
      deliverAfterResponse(db, [id]);
    }
  }
  return json(deliveryAnswer("reset_requested"), 202);
});
