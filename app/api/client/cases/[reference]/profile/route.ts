import { z } from "zod";
import { clientCaseByReference } from "@/lib/server/client-auth";
import { ProfileInvalid, profileView, saveProfile, validateProfile } from "@/lib/server/client-profile";
import { refreshChecklist } from "@/lib/server/checklist";
import { getDb } from "@/lib/server/db";
import { apiRoute, json, jsonError, readJson } from "@/lib/server/http";
import { limits } from "@/lib/server/limits";
import { clientPrincipal, clientUnauthenticated } from "@/lib/server/principals";
import { HOUR, withinLimit } from "@/lib/server/rate-limit";
import { caseView } from "@/lib/server/views";

export const runtime = "nodejs";

const Body = z.strictObject({
  full_name: z.string().max(200).nullish(),
  bank_name: z.string().max(200).nullish(),
  account_last4: z.string().max(10).nullish(),
  financial_year: z.string().max(7).nullish(),
  income_sources: z.array(z.string().max(40)).max(20).nullish(),
});

export const POST = apiRoute(async (request, context: { params: Promise<{ reference: string }> }) => {
  const { reference } = await context.params;
  const body = await readJson(request, Body);
  const db = getDb();
  const principal = await clientPrincipal(request, db);
  if (!principal) return clientUnauthenticated();
  const found = await clientCaseByReference(db, principal, reference);
  if (!found) return jsonError(404, "not_found", "Not found.");
  if (!await withinLimit(db, "client-profile", principal.clientIdentityId, limits.CLIENT_PROFILE_UPDATES_PER_CLIENT, HOUR)) {
    return jsonError(429, "rate_limited", "Too many attempts. Please try again later.");
  }
  let values;
  try {
    values = validateProfile(body, found.financial_year);
  } catch (error) {
    if (error instanceof ProfileInvalid) {
      return jsonError(400, "invalid_request", "Please check the highlighted details.", { fields: error.fields });
    }
    throw error;
  }
  const updated = await saveProfile(db, principal.firmId, found.id, values);
  await refreshChecklist(db, principal.firmId, found.id); // declared income situations change the suggestions
  return json({ case: caseView(updated), profile: profileView(updated) });
});
