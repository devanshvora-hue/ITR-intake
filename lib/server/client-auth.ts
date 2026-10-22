// Client onboarding (ported from client_auth.py): firm code + e-mail, an
// e-mailed sign-in link, client sessions and opening a case. The website now
// signs clients in directly (client-entry.ts); the e-mailed-link functions
// here are kept so verification can be switched back on.
//
// A client's firm, identity and firm code come only from the server-side
// session; nothing accepts a client, firm or case ID from the browser. The
// firm code must still be usable (active code of an active firm) when the link
// is issued, when it is redeemed and when a case is opened.

import { recordAudit } from "./audit";
import { consumeChallenge, redeemChallenge, VerificationFailed } from "./ca-auth";
import type { Db } from "./db";
import { Conflict, guarded, InvalidInput } from "./errors";
import { cleanCode, isFirmCodeUsable } from "./firm-codes";
import { newCaseReference, newToken, normaliseEmail, tokenHash, validateFinancialYear } from "./ids";
import {
  createSession, isExpired, nextIdle, revokePresented, revokeSession, sessionForToken, SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS, touchSession,
} from "./sessions";

export const CLIENT_CHALLENGE_TTL_S = 30 * 60;
export const CLIENT_CHALLENGE_ATTEMPTS = 5;
const FINANCIAL_YEARS_OFFERED = 3;
const REFERENCE_ATTEMPTS = 5;

export type ClientPrincipal = {
  clientIdentityId: string;
  firmId: string;
  firmCodeId: string | null;
  email: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export class OnboardingClosed extends Error {
  constructor() {
    super("The firm code behind this session can no longer open cases.");
    this.name = "OnboardingClosed";
  }
}

/**
 * Issue a sign-in link for a valid firm code and e-mail; otherwise null
 * (never an error that reveals which part failed).
 */
export async function startClientOnboarding(db: Db, firmCode: unknown, email: unknown):
  Promise<{ email: string; firmId: string; token: string } | null> {
  let emailNorm: string;
  try {
    emailNorm = normaliseEmail(email);
  } catch {
    return null;
  }
  const code = cleanCode(firmCode);
  if (!code) return null;
  const [firm] = await db.query<{ firm_id: string; firm_code_id: string }>(
    `SELECT f.id AS firm_id, c.id AS firm_code_id FROM firm_codes c JOIN firms f ON f.id = c.firm_id
     WHERE c.code = $1 AND c.status = 'active' AND f.status = 'active'`, [code]);
  if (!firm) return null;
  const secret = newToken();
  const id = await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE verification_challenges SET expires_at = now()
       WHERE purpose = 'client_login' AND firm_id = $1 AND subject = $2 AND consumed_at IS NULL AND expires_at > now()`,
      [firm.firm_id, emailNorm]);
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO verification_challenges (purpose, firm_id, firm_code_id, subject, secret_hash, max_attempts, expires_at)
       VALUES ('client_login', $1, $2, $3, $4, $5, now() + make_interval(secs => $6::double precision)) RETURNING id`,
      [firm.firm_id, firm.firm_code_id, emailNorm, tokenHash(secret), CLIENT_CHALLENGE_ATTEMPTS, CLIENT_CHALLENGE_TTL_S]);
    return row.id;
  });
  return { email: emailNorm, firmId: firm.firm_id, token: `${id}.${secret}` };
}

/**
 * Redeem a sign-in link and open a client session. Any problem (bad, used,
 * expired or superseded link; code revoked; firm inactive) raises
 * VerificationFailed with no further detail.
 */
export async function verifyClient(db: Db, token: unknown, now: Date = new Date()):
  Promise<{ token: string; principal: ClientPrincipal }> {
  const challenge = await redeemChallenge(db, token, "client_login");
  const firmId = challenge.firm_id as string;
  const sessionToken = newToken();
  await db.transaction(async (tx) => {
    if (!await consumeChallenge(tx, challenge.id)) throw new VerificationFailed();
    if (!challenge.firm_code_id || !await isFirmCodeUsable(tx, firmId, challenge.firm_code_id)) {
      throw new VerificationFailed();
    }
    await tx.query(
      `INSERT INTO client_identities (firm_id, email_norm) VALUES ($1, $2)
       ON CONFLICT (firm_id, email_norm) DO NOTHING`, [firmId, challenge.subject]);
    const [identity] = await tx.query<{ id: string }>(
      `UPDATE client_identities SET email_verified_at = COALESCE(email_verified_at, now())
       WHERE firm_id = $1 AND email_norm = $2 RETURNING id`, [firmId, challenge.subject]);
    await createSession(tx, {
      kind: "client", firmId, clientIdentityId: identity.id, token: sessionToken, firmCodeId: challenge.firm_code_id,
      idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
      absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
    });
  });
  const principal = await authenticateClient(db, sessionToken, now);
  if (!principal) throw new VerificationFailed();
  return { token: sessionToken, principal };
}

/**
 * Resolve a client token, sliding the idle timeout. Expired sessions and
 * sessions whose identity or firm is no longer usable are revoked (null).
 */
export async function authenticateClient(db: Db, token: unknown, now: Date = new Date()): Promise<ClientPrincipal | null> {
  const session = await sessionForToken(db, token, "client");
  if (!session) return null;
  if (isExpired(session, now)) {
    await revokeSession(db, session.id);
    return null;
  }
  // Direct entry (client-entry.ts) creates sessions for identities whose e-mail
  // is not verified, so a verified e-mail is no longer required here.
  const [identity] = await db.query<{ id: string; email_norm: string }>(
    "SELECT id, email_norm FROM client_identities WHERE id = $1 AND firm_id = $2",
    [session.client_identity_id, session.firm_id]);
  const [firm] = await db.query<{ status: string }>("SELECT status FROM firms WHERE id = $1", [session.firm_id]);
  if (!identity || !firm || firm.status !== "active") {
    await revokeSession(db, session.id);
    return null;
  }
  const idle = nextIdle(session, now);
  await touchSession(db, session.id, idle);
  return { clientIdentityId: identity.id, firmId: session.firm_id, firmCodeId: session.firm_code_id,
    email: identity.email_norm, idleExpiresAt: idle, absoluteExpiresAt: session.absolute_expires_at };
}

export async function logoutClient(db: Db, token: unknown): Promise<void> {
  await revokePresented(db, token, "client");
}

// --- cases ----------------------------------------------------------------------------------------

/** The current Indian financial year (April-March) and the two before it, newest first. */
export function financialYearOptions(today: Date = new Date()): string[] {
  const start = today.getUTCMonth() >= 3 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
  return Array.from({ length: FINANCIAL_YEARS_OFFERED }, (_, i) => {
    const y = start - i;
    return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
  });
}

export async function canOpenCases(db: Db, principal: ClientPrincipal): Promise<boolean> {
  return principal.firmCodeId !== null && isFirmCodeUsable(db, principal.firmId, principal.firmCodeId);
}

export type CaseRow = {
  id: string; firm_id: string; client_identity_id: string; reference: string; financial_year: string;
  client_first_name: string; profile_json: Record<string, unknown>; status: string; version: number;
  created_at: Date; updated_at: Date; reviewed_upload_id: string | null;
};

async function findOpenCase(db: Db, principal: ClientPrincipal, financialYear: string): Promise<CaseRow | null> {
  const [row] = await db.query<CaseRow>(
    `SELECT * FROM cases WHERE firm_id = $1 AND client_identity_id = $2 AND financial_year = $3 AND status <> 'closed'`,
    [principal.firmId, principal.clientIdentityId, financialYear]);
  return row ?? null;
}

/**
 * Open the client's case for a financial year, or return the open one (repeats
 * never create a second case). InvalidInput for a year not offered or a bad
 * name; OnboardingClosed if the session's firm code is no longer usable.
 */
export async function openCase(db: Db, principal: ClientPrincipal, input: { firstName: unknown; financialYear: unknown },
                               today?: Date): Promise<{ case: CaseRow; created: boolean }> {
  const year = typeof input.financialYear === "string" ? input.financialYear : "";
  if (!financialYearOptions(today).includes(year)) throw new InvalidInput("financial_year");
  validateFinancialYear(year);
  if (typeof input.firstName !== "string" || !input.firstName.trim() || input.firstName.length > 100) {
    throw new InvalidInput("first_name");
  }
  const name = input.firstName.trim();
  for (let round = 0; round < 2; round++) {
    const existing = await findOpenCase(db, principal, year);
    if (existing) return { case: existing, created: false };
    if (!await canOpenCases(db, principal)) throw new OnboardingClosed();
    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt++) {
      try {
        const created = await guarded(() => db.transaction(async (tx) => {
          const [row] = await tx.query<CaseRow>(
            `INSERT INTO cases (firm_id, client_identity_id, reference, financial_year, client_first_name,
                                created_via_firm_code_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [principal.firmId, principal.clientIdentityId, newCaseReference(name), year, name, principal.firmCodeId]);
          await recordAudit(tx, { actorKind: "client", actorId: principal.clientIdentityId, firmId: principal.firmId,
            caseId: row.id, action: "case.created" });
          return row;
        }), "case");
        return { case: created, created: true };
      } catch (error) {
        if (error instanceof Conflict && error.code === "reference_taken") continue;
        if (error instanceof Conflict && error.code === "open_case_exists") break; // a concurrent request opened it
        throw error;
      }
    }
  }
  const existing = await findOpenCase(db, principal, year);
  if (existing) return { case: existing, created: false };
  throw new Conflict("reference_taken");
}

export async function clientCaseByReference(db: Db, principal: ClientPrincipal, reference: unknown): Promise<CaseRow | null> {
  if (typeof reference !== "string" || !/^IT-[A-Z]{1,12}-[0-9A-Z]{6}$/.test(reference)) return null;
  const [row] = await db.query<CaseRow>(
    "SELECT * FROM cases WHERE reference = $1 AND firm_id = $2 AND client_identity_id = $3",
    [reference, principal.firmId, principal.clientIdentityId]);
  return row ?? null;
}
