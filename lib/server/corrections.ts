// The CA's classification decisions on reviewed rows (migration 0005).
//
// statement_rows is never edited: it keeps what was extracted and what the
// classifier said, and is rebuilt when a review is prepared. A decision is
// stored per (case, reviewed upload, row number) with a fingerprint of the
// row's raw extracted text, so re-preparing the same upload keeps every
// decision whose row still reads the same, and a decision never lands on a
// different transaction. Every change is an audit event (row number and
// category names only).

import { CATEGORIES, type Category } from "../statement/classifier";
import { recordAudit } from "./audit";
import type { Db } from "./db";
import { sha256Hex } from "./ids";

export const MAX_DECISION_NOTE = 300;

type RawRow = { raw_date: string | null; raw_narration: string | null; raw_debit: string | null; raw_credit: string | null;
  raw_balance: string | null };

export function rowFingerprint(r: RawRow): string {
  return sha256Hex(JSON.stringify([r.raw_date, r.raw_narration, r.raw_debit, r.raw_credit, r.raw_balance]));
}

export type Decision = { category: Category; decision: "confirmed" | "changed"; note: string | null; decidedAt: Date;
  fingerprint: string };

/** Decisions for one reviewed upload, by row number. */
export async function loadDecisions(db: Db, firmId: string, caseId: string, uploadId: string): Promise<Map<number, Decision>> {
  const rows = await db.query<{ row_number: number; row_fingerprint: string; category: Category; decision: "confirmed" | "changed";
    note: string | null; decided_at: Date }>(
    `SELECT row_number, row_fingerprint, category, decision, note, decided_at FROM classification_corrections
     WHERE case_id = $1 AND firm_id = $2 AND upload_id = $3`, [caseId, firmId, uploadId]);
  return new Map(rows.map((r) => [r.row_number, { category: r.category, decision: r.decision, note: r.note,
    decidedAt: r.decided_at, fingerprint: r.row_fingerprint }]));
}

export class DecisionRefused extends Error {
  constructor(readonly code: "no_review" | "row_not_found" | "row_not_valid" | "case_closed" | "invalid_category" | "invalid_note") {
    super(code);
    this.name = "DecisionRefused";
  }
}

/**
 * Record the CA's decision on one valid row of the case's current review:
 * a category (the classifier's own = confirmed, another = changed), or null to
 * withdraw the decision and return to the classifier's category.
 */
export async function decideRow(db: Db, input: { firmId: string; caseRow: { id: string; status: string;
  reviewed_upload_id: string | null }; actorId: string; rowNumber: number; category: string | null; note: unknown }): Promise<void> {
  const { firmId, caseRow } = input;
  if (caseRow.status === "closed") throw new DecisionRefused("case_closed");
  if (!caseRow.reviewed_upload_id) throw new DecisionRefused("no_review");
  if (input.category !== null && !(CATEGORIES as readonly string[]).includes(input.category)) {
    throw new DecisionRefused("invalid_category");
  }
  let note: string | null = null;
  if (input.note !== null && input.note !== undefined) {
    if (typeof input.note !== "string") throw new DecisionRefused("invalid_note");
    note = input.note.replace(/\s+/g, " ").trim() || null;
    if (note && (note.length > MAX_DECISION_NOTE || /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(note))) {
      throw new DecisionRefused("invalid_note");
    }
  }
  await db.transaction(async (tx) => {
    const [row] = await tx.query<RawRow & { is_valid: boolean; category: Category | null }>(
      `SELECT is_valid, category, raw_date, raw_narration, raw_debit, raw_credit, raw_balance FROM statement_rows
       WHERE case_id = $1 AND firm_id = $2 AND row_number = $3`, [caseRow.id, firmId, input.rowNumber]);
    if (!row) throw new DecisionRefused("row_not_found");
    if (!row.is_valid || row.category === null) throw new DecisionRefused("row_not_valid");
    const [previous] = await tx.query<{ category: string }>(
      "SELECT category FROM classification_corrections WHERE case_id = $1 AND firm_id = $2 AND upload_id = $3 AND row_number = $4",
      [caseRow.id, firmId, caseRow.reviewed_upload_id, input.rowNumber]);
    if (input.category === null) {
      await tx.query("DELETE FROM classification_corrections WHERE case_id = $1 AND firm_id = $2 AND upload_id = $3 AND row_number = $4",
        [caseRow.id, firmId, caseRow.reviewed_upload_id, input.rowNumber]);
      if (previous) {
        await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id, action: "case.classification_reset",
          details: { row_number: input.rowNumber, from: previous.category, to: row.category } });
      }
      return;
    }
    const decision = input.category === row.category ? "confirmed" : "changed";
    await tx.query(
      `INSERT INTO classification_corrections (case_id, firm_id, upload_id, row_number, row_fingerprint, original_category,
         category, decision, note, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (case_id, upload_id, row_number) DO UPDATE SET row_fingerprint = EXCLUDED.row_fingerprint,
         original_category = EXCLUDED.original_category, category = EXCLUDED.category, decision = EXCLUDED.decision,
         note = EXCLUDED.note, decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [caseRow.id, firmId, caseRow.reviewed_upload_id, input.rowNumber, rowFingerprint(row), row.category, input.category,
        decision, note, input.actorId]);
    await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id,
      action: decision === "confirmed" ? "case.classification_confirmed" : "case.classification_changed",
      details: { row_number: input.rowNumber, from: previous?.category ?? row.category, to: input.category } });
  });
}
