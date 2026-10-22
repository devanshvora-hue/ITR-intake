// Shared handling for the firm-code change routes: owner only, rate-limited,
// fixed error answers. The firm is always the signed-in CA's own.

import type { CaPrincipal } from "./ca-auth";
import { getDb, type Db } from "./db";
import { canManage, FirmCodeError } from "./firm-codes";
import { clientAddress, jsonError } from "./http";
import { limits } from "./limits";
import { caPrincipal, caUnauthenticated } from "./principals";
import { HOUR, withinAll } from "./rate-limit";

export async function firmCodeChange(request: Request,
                                     action: (db: Db, principal: CaPrincipal) => Promise<Response>): Promise<Response> {
  const db = getDb();
  const principal = await caPrincipal(request, db);
  if (!principal) return caUnauthenticated();
  if (!canManage(principal)) return jsonError(403, "not_permitted", "Only the firm owner can change the firm code.");
  if (!await withinAll(db, [
    ["firm-code-firm", principal.firmId, limits.FIRM_CODE_CHANGES_PER_FIRM, HOUR],
    ["firm-code-peer", clientAddress(request), limits.FIRM_CODE_CHANGES_PER_ADDRESS, HOUR],
  ])) {
    return jsonError(429, "rate_limited", "Too many firm code changes. Please try again later.");
  }
  try {
    return await action(db, principal);
  } catch (error) {
    if (error instanceof FirmCodeError) {
      if (error.code === "no_active_code") return jsonError(409, "no_active_code", "Your firm has no active code.");
      return jsonError(503, "unavailable", "A firm code could not be created. Please try again.");
    }
    throw error;
  }
}
