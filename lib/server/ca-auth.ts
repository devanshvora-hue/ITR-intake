// CA authentication (ported from ca_auth.py): registration, login, sessions,
// logout and password reset.
//
// Prototype policy: a firm is usable as soon as it registers. Registration
// creates the firm and its owner as 'active' (approved_by "self-registration";
// the e-mail is not verified) and signs the owner in. There is no e-mail
// verification and no operator approval. Accounts left 'pending' by the
// earlier verify-and-approve flow are activated on their first correct
// sign-in. Only an active user of an active firm can sign in: a suspended firm
// or a disabled user stays locked out.
//
// Login failures all raise the same AuthenticationFailed, whatever the cause,
// and always spend one scrypt run. Tokens are returned once and stored only as
// SHA-256 hashes. Nothing here logs passwords, tokens or rows.

import { timingSafeEqual } from "node:crypto";
import { recordAudit } from "./audit";
import type { Db } from "./db";
import { Conflict, guarded, InvalidInput, one } from "./errors";
import { isId, isToken, newToken, normaliseEmail, tokenHash } from "./ids";
import { checkPassword, checkPasswordPolicy, hashPassword } from "./passwords";
import {
  createSession, isExpired, nextIdle, revokePresented, revokeSession, sessionForToken, SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS, touchSession,
} from "./sessions";

export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const PASSWORD_RESET_TTL_S = 30 * 60;
export const PASSWORD_RESET_ATTEMPTS = 5;

export class AuthenticationFailed extends Error {
  constructor() {
    super("Invalid email or password.");
    this.name = "AuthenticationFailed";
  }
}

export class VerificationFailed extends Error {
  constructor() {
    super("Verification link is invalid or has expired.");
    this.name = "VerificationFailed";
  }
}

export class RegistrationError extends Error {
  constructor(readonly code: string) {
    super(`Registration could not be completed (${code}).`);
    this.name = "RegistrationError";
  }
}

type CaUser = {
  id: string; firm_id: string; email_norm: string; full_name: string; password_hash: string; status: string;
  role: string; email_verified_at: Date | null; locked_until: Date | null;
};
type Firm = { id: string; name: string; status: string };

export type CaPrincipal = {
  userId: string;
  firmId: string;
  role: string;
  email: string;
  fullName: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

async function userForLogin(db: Db, email: unknown): Promise<CaUser | null> {
  let emailNorm: string;
  try {
    emailNorm = normaliseEmail(email);
  } catch {
    return null;
  }
  const [user] = await db.query<CaUser>("SELECT * FROM ca_users WHERE email_norm = $1", [emailNorm]);
  return user ?? null;
}

async function getFirm(db: Db, firmId: string): Promise<Firm> {
  return one(await db.query<Firm>("SELECT id, name, status FROM firms WHERE id = $1", [firmId]));
}

function accountUsable(user: CaUser, firm: Firm, now: Date): boolean {
  return user.status === "active" && firm.status === "active" && (user.locked_until === null || user.locked_until <= now);
}

const SELF_REGISTERED = "self-registration";
const LEGACY_PENDING_FIRM = ["pending_verification", "pending_approval"];

function newSessionTimes(now: Date) {
  return { idleExpiresAt: new Date(now.getTime() + Math.min(SESSION_IDLE_MS, SESSION_ABSOLUTE_MS)),
    absoluteExpiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS) };
}

// --- registration ------------------------------------------------------------------------------------

export type RegistrationInput = {
  full_name: string; email: string; password: string; firm_name: string;
  contact_phone?: string | null; contact_address?: string | null; registration_number?: string | null;
};

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new RegistrationError(`${field}_invalid`);
  return value;
}

/**
 * Create an active firm and its active owner and open the owner's session, atomically. A presented earlier CA
 * session is revoked. RegistrationError for invalid input or a duplicate e-mail / registration number.
 */
export async function registerCa(db: Db, input: RegistrationInput, previousToken: string | null = null,
                                 now: Date = new Date()): Promise<{ firmId: string; userId: string; email: string; token: string }> {
  try {
    checkPasswordPolicy(input.password);
  } catch (error) {
    throw new RegistrationError((error as { code: string }).code);
  }
  let email: string;
  try {
    email = normaliseEmail(input.email);
  } catch {
    throw new RegistrationError("email_invalid");
  }
  const firmName = requiredText(input.firm_name, "name", 200);
  const fullName = requiredText(input.full_name, "full_name", 200);
  const registrationNumber = input.registration_number == null ? null
    : requiredText(input.registration_number, "registration_number", 64);
  const passwordHash = await hashPassword(input.password);
  const token = newToken();
  try {
    return await guarded(() => db.transaction(async (tx) => {
      const [firm] = await tx.query<{ id: string }>(
        `INSERT INTO firms (name, contact_phone, contact_address, registration_number, status, approved_at, approved_by)
         VALUES ($1, $2, $3, $4, 'active', now(), $5) RETURNING id`,
        [firmName, input.contact_phone ?? null, input.contact_address ?? null, registrationNumber, SELF_REGISTERED]);
      const [user] = await tx.query<{ id: string }>(
        `INSERT INTO ca_users (firm_id, email_norm, full_name, password_hash, role, status)
         VALUES ($1, $2, $3, $4, 'owner', 'active') RETURNING id`, [firm.id, email, fullName, passwordHash]);
      if (previousToken) await revokePresented(tx, previousToken, "ca");
      await createSession(tx, { kind: "ca", firmId: firm.id, caUserId: user.id, token, ...newSessionTimes(now) });
      await recordAudit(tx, { actorKind: "ca", actorId: user.id, firmId: firm.id, action: "ca.registered" });
      return { firmId: firm.id, userId: user.id, email, token };
    }), "registration");
  } catch (error) {
    if (error instanceof Conflict) throw new RegistrationError(error.code);
    if (error instanceof InvalidInput) throw new RegistrationError(`${error.field}_invalid`);
    throw error;
  }
}

// --- one-time challenges ----------------------------------------------------------------------------

type Purpose = "ca_password_reset" | "client_login";

export type Challenge = {
  id: string; purpose: Purpose; firm_id: string | null; ca_user_id: string | null; firm_code_id: string | null;
  subject: string; secret_hash: string; consumed_at: Date | null; expires_at: Date;
};

/** End outstanding challenges of this purpose for the user and issue a new one: "<id>.<secret>". */
async function issueChallenge(db: Db, purpose: Purpose, user: { id: string; firm_id: string }, ttlSeconds: number,
                              attempts: number): Promise<string> {
  const secret = newToken();
  const id = await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE verification_challenges SET expires_at = now()
       WHERE purpose = $1 AND ca_user_id = $2 AND consumed_at IS NULL AND expires_at > now()`, [purpose, user.id]);
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO verification_challenges (purpose, firm_id, ca_user_id, subject, secret_hash, max_attempts, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::double precision)) RETURNING id`,
      [purpose, user.firm_id, user.id, user.id, tokenHash(secret), attempts, ttlSeconds]);
    return row.id;
  });
  return `${id}.${secret}`;
}

/**
 * Check a "<id>.<secret>" token for `purpose` and count the attempt (a wrong
 * secret still uses one up). Returns the challenge when the secret matches;
 * the caller consumes it inside its own transaction.
 */
export async function redeemChallenge(db: Db, token: unknown, purpose: Purpose): Promise<Challenge> {
  if (typeof token !== "string" || token.split(".").length !== 2) throw new VerificationFailed();
  const [id, secret] = token.split(".");
  if (!isId(id) || !isToken(secret)) throw new VerificationFailed();
  const [challenge] = await db.query<Challenge>("SELECT * FROM verification_challenges WHERE id = $1", [id]);
  if (!challenge || challenge.purpose !== purpose || challenge.consumed_at !== null || challenge.expires_at <= new Date()) {
    throw new VerificationFailed();
  }
  const counted = await db.query(
    `UPDATE verification_challenges SET attempts = attempts + 1
     WHERE id = $1 AND consumed_at IS NULL AND attempts < max_attempts RETURNING id`, [id]);
  if (counted.length === 0) throw new VerificationFailed();
  const expected = Buffer.from(challenge.secret_hash, "hex");
  const actual = Buffer.from(tokenHash(secret), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new VerificationFailed();
  return challenge;
}

/** Mark a challenge used; true only for the first call (single use, even under a race). */
export async function consumeChallenge(db: Db, id: string): Promise<boolean> {
  const rows = await db.query(
    "UPDATE verification_challenges SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id", [id]);
  return rows.length === 1;
}

// --- password reset -------------------------------------------------------------------------------------

export class PasswordResetFailed extends Error {
  constructor() {
    super("Reset link is invalid or has expired.");
    this.name = "PasswordResetFailed";
  }
}

/** A reset token for an account that may still sign in; null for unknown, malformed or disabled e-mails. */
export async function requestPasswordReset(db: Db, email: unknown): Promise<{ email: string; token: string } | null> {
  const user = await userForLogin(db, email);
  if (!user || user.status === "disabled") return null;
  const token = await issueChallenge(db, "ca_password_reset", user, PASSWORD_RESET_TTL_S, PASSWORD_RESET_ATTEMPTS);
  return { email: user.email_norm, token };
}

/**
 * Set a new password from a reset token, revoke every session of the account
 * and clear its lock. The policy is checked before the token is touched
 * (PasswordPolicyError); token problems raise PasswordResetFailed.
 */
export async function confirmPasswordReset(db: Db, token: unknown, newPassword: unknown): Promise<void> {
  checkPasswordPolicy(newPassword);
  let challenge: Challenge;
  try {
    challenge = await redeemChallenge(db, token, "ca_password_reset");
  } catch {
    throw new PasswordResetFailed();
  }
  const newHash = await hashPassword(newPassword as string);
  await db.transaction(async (tx) => {
    const [user] = await tx.query<{ status: string }>("SELECT status FROM ca_users WHERE id = $1 AND firm_id = $2",
      [challenge.ca_user_id, challenge.firm_id]);
    if (!user || user.status === "disabled" || !await consumeChallenge(tx, challenge.id)) throw new PasswordResetFailed();
    await tx.query(`UPDATE ca_users SET password_hash = $3, failed_logins = 0, locked_until = NULL, updated_at = now()
                    WHERE id = $1 AND firm_id = $2`, [challenge.ca_user_id, challenge.firm_id, newHash]);
    await tx.query("UPDATE sessions SET revoked_at = now() WHERE ca_user_id = $1 AND firm_id = $2 AND revoked_at IS NULL",
      [challenge.ca_user_id, challenge.firm_id]);
  });
}

// --- login, sessions, logout ------------------------------------------------------------------------

/**
 * Authenticate a CA and open a new session. Any failure raises one generic
 * AuthenticationFailed. Wrong passwords count towards a temporary lock. On
 * success a fresh token is issued and a presented earlier token is revoked.
 */
export async function loginCa(db: Db, email: unknown, password: unknown, previousToken: string | null,
                              now: Date = new Date()): Promise<{ token: string; principal: CaPrincipal }> {
  const user = await userForLogin(db, email);
  if (!user) {
    await checkPassword(password, null);
    throw new AuthenticationFailed();
  }
  const passwordOk = await checkPassword(password, user.password_hash);
  const firm = await getFirm(db, user.firm_id);
  if (!passwordOk) {
    // One relative UPDATE, so concurrent failures are all counted. An expired lock restarts the count.
    await db.query(
      `UPDATE ca_users SET
         failed_logins = CASE WHEN locked_until IS NOT NULL AND locked_until <= $2 THEN 1 ELSE failed_logins + 1 END,
         locked_until = CASE WHEN locked_until IS NOT NULL AND locked_until <= $2 THEN NULL
                             WHEN failed_logins + 1 >= $3 THEN $4 ELSE locked_until END,
         updated_at = now()
       WHERE id = $1`, [user.id, now, MAX_FAILED_LOGINS, new Date(now.getTime() + LOCKOUT_MS)]);
    throw new AuthenticationFailed();
  }
  // An account left pending by the earlier verify-and-approve flow is activated by its owner's correct password.
  // Suspended firms and disabled users are never activated here.
  const legacyPending = user.status === "pending" && LEGACY_PENDING_FIRM.includes(firm.status);
  const usable = legacyPending ? { ...user, status: "active" } : user;
  if (!accountUsable(usable, legacyPending ? { ...firm, status: "active" } : firm, now)) throw new AuthenticationFailed();
  const token = newToken();
  await db.transaction(async (tx) => {
    if (legacyPending) {
      await tx.query(`UPDATE firms SET status = 'active', approved_at = COALESCE(approved_at, now()),
                        approved_by = COALESCE(approved_by, $2), updated_at = now() WHERE id = $1`, [firm.id, SELF_REGISTERED]);
      await tx.query("UPDATE ca_users SET status = 'active', updated_at = now() WHERE id = $1", [user.id]);
      await recordAudit(tx, { actorKind: "ca", actorId: user.id, firmId: firm.id, action: "ca.activated",
        details: { previous_firm_status: firm.status } });
    }
    if (previousToken) await revokePresented(tx, previousToken, "ca");
    await tx.query("UPDATE ca_users SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [user.id]);
    await createSession(tx, { kind: "ca", firmId: user.firm_id, caUserId: user.id, token, ...newSessionTimes(now) });
  });
  const principal = await authenticateCa(db, token, now);
  if (!principal) throw new AuthenticationFailed();
  return { token, principal };
}

/**
 * Resolve a presented token to a CA principal, sliding the idle timeout.
 * Expired sessions, and sessions whose user or firm is no longer usable, are
 * revoked and give null. The firm comes from the stored session and account.
 */
export async function authenticateCa(db: Db, token: unknown, now: Date = new Date()): Promise<CaPrincipal | null> {
  const session = await sessionForToken(db, token, "ca");
  if (!session) return null;
  if (isExpired(session, now)) {
    await revokeSession(db, session.id);
    return null;
  }
  const [user] = await db.query<CaUser>("SELECT * FROM ca_users WHERE id = $1 AND firm_id = $2",
    [session.ca_user_id, session.firm_id]);
  const [firm] = await db.query<Firm>("SELECT id, name, status FROM firms WHERE id = $1", [session.firm_id]);
  if (!user || !firm || !accountUsable(user, firm, now)) {
    await revokeSession(db, session.id);
    return null;
  }
  const idle = nextIdle(session, now);
  await touchSession(db, session.id, idle);
  return {
    userId: user.id, firmId: user.firm_id, role: user.role, email: user.email_norm, fullName: user.full_name,
    idleExpiresAt: idle, absoluteExpiresAt: session.absolute_expires_at,
  };
}

export async function logoutCa(db: Db, token: unknown): Promise<void> {
  await revokePresented(db, token, "ca");
}

