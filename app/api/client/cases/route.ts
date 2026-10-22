import { z } from "zod";
import { OnboardingClosed, openCase } from "@/lib/server/client-auth";
import { getDb } from "@/lib/server/db";
import { InvalidInput } from "@/lib/server/errors";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { clientPrincipal, clientUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { caseView } from "@/lib/server/views";

export const runtime = "nodejs";

const Body = z.strictObject({ first_name: z.string().min(1).max(100), financial_year: z.string().max(7) });

export const POST = apiRoute(async (request) => {
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await clientPrincipal(request, db);
  if (!principal) return clientUnauthenticated();
  if (!await withinLimit(db, "client-cases", principal.clientIdentityId, limits.CLIENT_CASES_PER_CLIENT, HOUR)) {
    return jsonError(429, "rate_limited", "Too many attempts. Please try again later.");
  }
  try {
    const result = await openCase(db, principal, { firstName: body.first_name, financialYear: body.financial_year });
    return json({ case: caseView(result.case), created: result.created }, result.created ? 201 : 200);
  } catch (error) {
    if (error instanceof InvalidInput) {
      return jsonError(400, "invalid_request", "Please check the highlighted details.", { fields: [error.field] });
    }
    if (error instanceof OnboardingClosed) {
      return jsonError(409, "onboarding_closed",
        "This firm code is no longer active. Please ask your CA for their current code.");
    }
    throw error;
  }
});
