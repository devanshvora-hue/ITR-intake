import { z } from "zod";
import { CLIENT_CHALLENGE_TTL_S, startClientOnboarding } from "@/lib/server/client-auth";
import { getConfig } from "@/lib/server/config";
import { getDb } from "@/lib/server/db";
import { canSendEmail, deliverAfterResponse, deliveryAnswer, queueEmail, TEMPLATE_CLIENT_SIGN_IN } from "@/lib/server/email";
import { apiRoute, clientAddress, json, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { HOUR, limitReached, withinAll, withinLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const Body = z.strictObject({ firm_code: z.string().max(64), email: z.string().max(254) });

// Always the same 202, whether or not the firm code is valid, mail was sent or
// a limit was hit. Mail goes out after the response, so timing reveals nothing.
export const POST = apiRoute(async (request) => {
  const body = await readJson(request, Body);
  const db = getDb();
  const address = clientAddress(request);
  const allowed = await withinAll(db, [
    ["client-start-email", body.email.trim().toLowerCase(), limits.CLIENT_STARTS_PER_EMAIL, HOUR],
    ["client-start-peer", address, limits.CLIENT_STARTS_PER_ADDRESS, HOUR],
    ["client-start-all", "all", limits.CLIENT_STARTS_ALL, HOUR],
  ]);
  const guessing = await limitReached(db, "client-bad-code-peer", address, limits.CLIENT_BAD_CODES_PER_ADDRESS, HOUR);
  if (allowed && !guessing && canSendEmail()) {
    const result = await startClientOnboarding(db, body.firm_code, body.email);
    if (result) {
      const id = await queueEmail(db, {
        template: TEMPLATE_CLIENT_SIGN_IN, recipient: result.email, token: result.token, firmId: result.firmId,
        link: `${getConfig().appBaseUrl}/client/verify#token=${result.token}`, ttlSeconds: CLIENT_CHALLENGE_TTL_S,
      });
      deliverAfterResponse(db, [id]);
    } else {
      await withinLimit(db, "client-bad-code-peer", address, limits.CLIENT_BAD_CODES_PER_ADDRESS, HOUR);
    }
  }
  return json(deliveryAnswer("check_email"), 202);
});
