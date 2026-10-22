// Firm codes for signed-in CAs (ported from firm_codes.py). A firm code lets
// a new client find their CA firm; it never authenticates anyone. At most one
// active code per firm (enforced by the database). The firm always comes from
// the CA principal; viewing is open to any CA of the firm, changes need the
// owner role. Rotation revokes the old code in the same transaction. Codes
// never appear in logs or audit details (audit holds the code's ID only).

import { recordAudit } from "./audit";
import type { CaPrincipal } from "./ca-auth";
import type { Db } from "./db";
import { Conflict, guarded } from "./errors";
import { formatFirmCode, newFirmCode } from "./ids";

const MAX_GENERATION_ATTEMPTS = 5;

export class FirmCodeError extends Error {
  constructor(readonly code: "not_permitted" | "no_active_code" | "generation_failed") {
    super(code);
    this.name = "FirmCodeError";
  }
}

type FirmCodeRow = { id: string; code: string; status: string; created_at: Date; revoked_at: Date | null };

export function codeView(row: FirmCodeRow) {
  return { code: row.code, display: formatFirmCode(row.code), status: row.status, created_at: row.created_at,
    revoked_at: row.revoked_at };
}

export function canManage(principal: CaPrincipal): boolean {
  return principal.role === "owner";
}

function requireManager(principal: CaPrincipal): void {
  if (!canManage(principal)) throw new FirmCodeError("not_permitted");
}

async function listCodes(db: Db, firmId: string, limit = 6): Promise<FirmCodeRow[]> {
  return db.query<FirmCodeRow>(
    "SELECT id, code, status, created_at, revoked_at FROM firm_codes WHERE firm_id = $1 ORDER BY created_at DESC, id LIMIT $2",
    [firmId, limit]);
}

/** Clean a typed code ("7k4p-92xm qr3t" -> "7K4P92XMQR3T"); null if malformed. */
export function cleanCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const value = code.replace(/[\s-]/g, "").toUpperCase();
  return /^[0-9A-Z]{8,32}$/.test(value) ? value : null;
}

export async function firmCodeState(db: Db, principal: CaPrincipal) {
  const rows = await listCodes(db, principal.firmId);
  const active = rows.find((r) => r.status === "active");
  return {
    active: active ? codeView(active) : null,
    previous: rows.filter((r) => r.status !== "active").slice(0, 5).map(codeView),
    can_manage: canManage(principal),
  };
}

/** The active code, created if the firm has none. */
export async function ensureFirmCode(db: Db, principal: CaPrincipal): Promise<{ view: ReturnType<typeof codeView>; created: boolean }> {
  requireManager(principal);
  for (let i = 0; i < MAX_GENERATION_ATTEMPTS; i++) {
    const [active] = await db.query<FirmCodeRow>(
      "SELECT id, code, status, created_at, revoked_at FROM firm_codes WHERE firm_id = $1 AND status = 'active'",
      [principal.firmId]);
    if (active) return { view: codeView(active), created: false };
    try {
      const row = await guarded(() => db.transaction(async (tx) => {
        const [created] = await tx.query<FirmCodeRow>(
          "INSERT INTO firm_codes (firm_id, code) VALUES ($1, $2) RETURNING id, code, status, created_at, revoked_at",
          [principal.firmId, newFirmCode()]);
        await recordAudit(tx, { actorKind: "ca", actorId: principal.userId, firmId: principal.firmId,
          action: "firm_code.created", details: { firm_code_id: created.id } });
        return created;
      }), "code");
      return { view: codeView(row), created: true };
    } catch (error) {
      // Another firm's code collided (try a new one), or a concurrent creation won (the next loop returns it).
      if (!(error instanceof Conflict && ["firm_code_taken", "active_firm_code_exists"].includes(error.code))) throw error;
    }
  }
  throw new FirmCodeError("generation_failed");
}

/** Revoke the active code and activate a new one atomically (a plain creation if none is active). */
export async function rotateFirmCode(db: Db, principal: CaPrincipal) {
  requireManager(principal);
  for (let i = 0; i < MAX_GENERATION_ATTEMPTS; i++) {
    try {
      const row = await guarded(() => db.transaction(async (tx) => {
        const revoked = await tx.query(
          "UPDATE firm_codes SET status = 'revoked', revoked_at = now() WHERE firm_id = $1 AND status = 'active' RETURNING id",
          [principal.firmId]);
        const [created] = await tx.query<FirmCodeRow>(
          "INSERT INTO firm_codes (firm_id, code) VALUES ($1, $2) RETURNING id, code, status, created_at, revoked_at",
          [principal.firmId, newFirmCode()]);
        await recordAudit(tx, { actorKind: "ca", actorId: principal.userId, firmId: principal.firmId,
          action: revoked.length ? "firm_code.rotated" : "firm_code.created", details: { firm_code_id: created.id } });
        return created;
      }), "code");
      return codeView(row);
    } catch (error) {
      if (!(error instanceof Conflict && error.code === "firm_code_taken")) throw error;
    }
  }
  throw new FirmCodeError("generation_failed");
}

/** Revoke the firm's active code. FirmCodeError("no_active_code") if there is none. */
export async function revokeActiveFirmCode(db: Db, principal: CaPrincipal) {
  requireManager(principal);
  return db.transaction(async (tx) => {
    const [row] = await tx.query<FirmCodeRow>(
      `UPDATE firm_codes SET status = 'revoked', revoked_at = now() WHERE firm_id = $1 AND status = 'active'
       RETURNING id, code, status, created_at, revoked_at`, [principal.firmId]);
    if (!row) throw new FirmCodeError("no_active_code");
    await recordAudit(tx, { actorKind: "ca", actorId: principal.userId, firmId: principal.firmId,
      action: "firm_code.revoked", details: { firm_code_id: row.id } });
    return codeView(row);
  });
}

/** True if this code of the firm is still active and the firm is active. */
export async function isFirmCodeUsable(db: Db, firmId: string, codeId: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM firm_codes c JOIN firms f ON f.id = c.firm_id
     WHERE c.id = $1 AND c.firm_id = $2 AND c.status = 'active' AND f.status = 'active'`, [codeId, firmId]);
  return rows.length > 0;
}
