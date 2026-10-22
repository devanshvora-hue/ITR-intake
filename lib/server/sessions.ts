// Server-side sessions (ported from ca_auth.py / client_auth.py). The cookie
// holds a random token; the database stores only its SHA-256. Every lookup
// starts from a presented token. 30 minutes idle, 12 hours absolute.

import type { Db } from "./db";
import { guarded } from "./errors";
import { isToken, tokenHash } from "./ids";

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

export type SessionRow = {
  id: string;
  kind: "ca" | "client";
  firm_id: string;
  ca_user_id: string | null;
  client_identity_id: string | null;
  firm_code_id: string | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
};

export async function createSession(db: Db, input: {
  kind: "ca" | "client"; firmId: string; token: string; idleExpiresAt: Date; absoluteExpiresAt: Date;
  caUserId?: string; clientIdentityId?: string; firmCodeId?: string | null;
}): Promise<void> {
  await guarded(() => db.query(
    `INSERT INTO sessions (token_hash, kind, firm_id, ca_user_id, client_identity_id, firm_code_id,
                           idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tokenHash(input.token), input.kind, input.firmId, input.caUserId ?? null, input.clientIdentityId ?? null,
      input.firmCodeId ?? null, input.idleExpiresAt, input.absoluteExpiresAt]), "session");
}

/** The non-revoked session of `kind` for a presented token, or null. */
export async function sessionForToken(db: Db, token: unknown, kind: "ca" | "client"): Promise<SessionRow | null> {
  if (!isToken(token)) return null;
  const [row] = await db.query<SessionRow>(
    `SELECT id, kind, firm_id, ca_user_id, client_identity_id, firm_code_id, idle_expires_at, absolute_expires_at
     FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL`, [tokenHash(token)]);
  return row && row.kind === kind ? row : null;
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1", [sessionId]);
}

export async function touchSession(db: Db, sessionId: string, idleExpiresAt: Date): Promise<void> {
  await db.query("UPDATE sessions SET last_seen_at = now(), idle_expires_at = $2 WHERE id = $1 AND revoked_at IS NULL",
    [sessionId, idleExpiresAt]);
}

/** Revoke the presented session of `kind`, if any. Silent otherwise (no oracle). */
export async function revokePresented(db: Db, token: unknown, kind: "ca" | "client"): Promise<void> {
  const session = await sessionForToken(db, token, kind);
  if (session) await revokeSession(db, session.id);
}

export function isExpired(session: SessionRow, now: Date): boolean {
  return now >= session.idle_expires_at || now >= session.absolute_expires_at;
}

export function nextIdle(session: SessionRow, now: Date): Date {
  return new Date(Math.min(now.getTime() + SESSION_IDLE_MS, session.absolute_expires_at.getTime()));
}
