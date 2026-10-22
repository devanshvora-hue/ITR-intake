// Append-only audit events. `details` must never hold personal or financial
// data: IDs and fixed codes only.

import type { Db } from "./db";
import { guarded } from "./errors";

export type AuditEvent = {
  actorKind: "ca" | "client" | "system" | "admin";
  action: string;
  firmId?: string | null;
  caseId?: string | null;
  actorId?: string | null;
  details?: Record<string, unknown>;
  ipHash?: string | null;
};

export async function recordAudit(db: Db, event: AuditEvent): Promise<void> {
  await guarded(() => db.query(
    `INSERT INTO audit_events (firm_id, case_id, actor_kind, actor_id, action, details_json, ip_hash)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [event.firmId ?? null, event.caseId ?? null, event.actorKind, event.actorId ?? null, event.action,
      JSON.stringify(event.details ?? {}), event.ipHash ?? null]), "audit_event");
}
