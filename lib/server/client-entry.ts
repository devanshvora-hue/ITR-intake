// Direct client entry: firm code + e-mail, no e-mailed link (demo setting).
//
// Identity assurance is deliberately reduced. The firm code only identifies a
// firm and the e-mail is an identifier the client typed; neither proves who
// the client is, and identities created here keep email_verified_at NULL so
// the CA can see they are unverified. To stop anyone who knows a firm code and
// an e-mail from opening that client's intake, a returning client must present
// either their existing session cookie (same browser) or the resume code shown
// once when they first started. Only a salted SHA-256 hash of the code is
// stored; attempts are rate-limited per identity.
//
// The e-mailed-link flow (startClientOnboarding / verifyClient in
// client-auth.ts) is unchanged and can be switched back on in the start route.

import { timingSafeEqual } from "node:crypto";
import { recordAudit } from "./audit";
import { authenticateClient, type ClientPrincipal } from "./client-auth";
import type { Db } from "./db";
import { guarded } from "./errors";
import { cleanCode } from "./firm-codes";
import { formatFirmCode, newFirmCode, newToken, normaliseEmail, sha256Hex } from "./ids";
import { limits } from "./limits";
import { HOUR, withinLimit } from "./rate-limit";
import { createSession, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "./sessions";

/** A refused entry; `code` is fixed and safe to show. */
export class EntryRefused extends Error {
  constructor(readonly code: "invalid_email" | "invalid_firm_code" | "resume_code_required" | "resume_code_invalid"
    | "rate_limited") {
    super(code);
    this.name = "EntryRefused";
  }
}

export type EntryResult = {
  /** A new session token to set as the cookie, or null when the presented session is kept. */
  token: string | null;
  principal: ClientPrincipal;
  /** Shown to the client exactly once ("XXXX-XXXX-XXXX"); null when no new code was issued. */
  resumeCode: string | null;
  created: boolean;
};

type IdentityRow = { id: string; resume_code_hash: string | null };

const resumeHash = (identityId: string, code: string) => sha256Hex(`itr-resume:${identityId}:${code}`);

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function issueResumeCode(tx: Db, firmId: string, identityId: string): Promise<string> {
  const code = newFirmCode(); // 12 symbols, about 60 random bits
  await tx.query(
    "UPDATE client_identities SET resume_code_hash = $3, resume_code_set_at = now() WHERE id = $1 AND firm_id = $2",
    [identityId, firmId, resumeHash(identityId, code)]);
  return formatFirmCode(code);
}

async function openSession(tx: Db, firmId: string, identityId: string, firmCodeId: string, token: string, now: Date) {
  await createSession(tx, {
    kind: "client", firmId, clientIdentityId: identityId, token, firmCodeId,
    idleExpiresAt: new Date(now.getTime() + SESSION_IDLE_MS),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
  });
}

/**
 * Enter (or re-enter) a firm's client portal. New e-mails get an identity, a
 * session and a resume code; known e-mails need the same browser's session or
 * the resume code. Throws EntryRefused.
 */
export async function enterClient(db: Db, input: { firmCode: unknown; email: unknown; resumeCode?: unknown;
  presentedToken?: string | null }, now: Date = new Date()): Promise<EntryResult> {
  let email: string;
  try {
    email = normaliseEmail(input.email);
  } catch {
    throw new EntryRefused("invalid_email");
  }
  const code = cleanCode(input.firmCode);
  const [firm] = code ? await db.query<{ firm_id: string; firm_code_id: string }>(
    `SELECT f.id AS firm_id, c.id AS firm_code_id FROM firm_codes c JOIN firms f ON f.id = c.firm_id
     WHERE c.code = $1 AND c.status = 'active' AND f.status = 'active'`, [code]) : [];
  if (!firm) throw new EntryRefused("invalid_firm_code");

  const [existing] = await db.query<IdentityRow>(
    "SELECT id, resume_code_hash FROM client_identities WHERE firm_id = $1 AND email_norm = $2", [firm.firm_id, email]);

  // Same browser, same client: keep the session.
  if (existing && input.presentedToken) {
    const current = await authenticateClient(db, input.presentedToken, now);
    if (current && current.firmId === firm.firm_id && current.clientIdentityId === existing.id) {
      return { token: null, principal: current, resumeCode: null, created: false };
    }
  }

  const token = newToken();
  let resumeCode: string | null = null;
  let created = false;
  if (!existing) {
    const identityId = await guarded(() => db.transaction(async (tx) => {
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO client_identities (firm_id, email_norm) VALUES ($1, $2)
         ON CONFLICT (firm_id, email_norm) DO NOTHING RETURNING id`, [firm.firm_id, email]);
      if (!row) return null; // created concurrently: treat as a returning client
      resumeCode = await issueResumeCode(tx, firm.firm_id, row.id);
      await openSession(tx, firm.firm_id, row.id, firm.firm_code_id, token, now);
      await recordAudit(tx, { actorKind: "client", actorId: row.id, firmId: firm.firm_id, action: "client.entered",
        details: { method: "direct", new_identity: true } });
      return row.id;
    }), "client_identity");
    if (identityId === null) throw new EntryRefused("resume_code_required");
    created = true;
  } else {
    const legacy = existing.resume_code_hash === null; // created by an e-mailed link before direct entry
    if (!legacy) {
      if (typeof input.resumeCode !== "string" || !input.resumeCode.trim()) throw new EntryRefused("resume_code_required");
      if (!await withinLimit(db, "client-resume", existing.id, limits.CLIENT_RESUME_ATTEMPTS_PER_IDENTITY, HOUR)) {
        throw new EntryRefused("rate_limited");
      }
      const presented = cleanCode(input.resumeCode);
      if (!presented || !sameHash(resumeHash(existing.id, presented), existing.resume_code_hash!)) {
        throw new EntryRefused("resume_code_invalid");
      }
    }
    await db.transaction(async (tx) => {
      // A legacy identity (no code yet) gets its first resume code now: a known trade-off for existing demo data.
      if (legacy) resumeCode = await issueResumeCode(tx, firm.firm_id, existing.id);
      await openSession(tx, firm.firm_id, existing.id, firm.firm_code_id, token, now);
      await recordAudit(tx, { actorKind: "client", actorId: existing.id, firmId: firm.firm_id, action: "client.entered",
        details: { method: legacy ? "direct_first_code" : "resume_code" } });
    });
  }
  const principal = await authenticateClient(db, token, now);
  if (!principal) throw new Error("new client session did not authenticate");
  return { token, principal, resumeCode, created };
}

/** A fresh resume code for the signed-in client (the old one stops working). */
export async function rotateResumeCode(db: Db, principal: ClientPrincipal): Promise<string> {
  return db.transaction(async (tx) => {
    const code = await issueResumeCode(tx, principal.firmId, principal.clientIdentityId);
    await recordAudit(tx, { actorKind: "client", actorId: principal.clientIdentityId, firmId: principal.firmId,
      action: "client.resume_code_rotated" });
    return code;
  });
}
