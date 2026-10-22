// The minimum client profile for statement ingestion (ported from
// client_profile.py): full name, bank name and the last four account digits.
// PAN, Aadhaar, full account numbers and credentials are never collected.

import type { CaseRow } from "./client-auth";
import type { Db } from "./db";
import { Conflict } from "./errors";

const NAME = /^\p{L}[\p{L} .'-]*$/u; // letters, spaces, . ' - only
const BANK = /^[\p{L}\p{N}_][\p{L}\p{N}_ .,'&()/-]*$/u;
const LAST4 = /^\d{4}$/;
const FIELDS = [
  { key: "full_name", pattern: NAME, low: 2, high: 100, required: true },
  { key: "bank_name", pattern: BANK, low: 2, high: 80, required: true },
  { key: "account_last4", pattern: LAST4, low: 4, high: 4, required: false },
] as const;

export type Profile = { full_name: string | null; bank_name: string | null; account_last4: string | null };

export class ProfileInvalid extends Error {
  constructor(readonly fields: string[]) {
    super("invalid profile");
    this.name = "ProfileInvalid";
  }
}

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new TypeError();
  return value.normalize("NFKC").replace(/\s+/g, " ").trim() || null;
}

/** Checked, normalised values; ProfileInvalid lists bad field names (never their contents). */
export function validateProfile(values: Record<string, unknown>, caseFinancialYear: string): Profile {
  const bad: string[] = [];
  const out: Record<string, string | null> = {};
  for (const { key, pattern, low, high, required } of FIELDS) {
    let text: string | null;
    try {
      text = clean(values[key]);
    } catch {
      bad.push(key);
      continue;
    }
    if (text === null) {
      if (required) bad.push(key);
      out[key] = null;
      continue;
    }
    if (text.length < low || text.length > high || !pattern.test(text) || /[\u0000-\u001f\u007f-\u009f]/.test(text)) {
      bad.push(key);
      continue;
    }
    out[key] = text;
  }
  const fy = values.financial_year;
  if (fy !== undefined && fy !== null && fy !== caseFinancialYear) bad.push("financial_year");
  if (bad.length) throw new ProfileInvalid(bad);
  return out as Profile;
}

export function profileView(row: Pick<CaseRow, "profile_json">) {
  const profile = (row.profile_json ?? {}) as Record<string, string | null>;
  const view = { full_name: profile.full_name ?? null, bank_name: profile.bank_name ?? null,
    account_last4: profile.account_last4 ?? null };
  return { ...view, complete: Boolean(view.full_name && view.bank_name) };
}

/** Merge the checked values into the case profile (optimistic locking, retried once). */
export async function saveProfile(db: Db, firmId: string, caseId: string, values: Profile): Promise<CaseRow> {
  for (let i = 0; i < 2; i++) {
    const [current] = await db.query<CaseRow>("SELECT * FROM cases WHERE id = $1 AND firm_id = $2", [caseId, firmId]);
    const profile = { ...(current.profile_json ?? {}), ...values };
    const [updated] = await db.query<CaseRow>(
      `UPDATE cases SET profile_json = $3::text::jsonb, version = version + 1, updated_at = now()
       WHERE id = $1 AND firm_id = $2 AND version = $4 RETURNING *`,
      [caseId, firmId, JSON.stringify(profile), current.version]);
    if (updated) return updated;
  }
  throw new Conflict("stale_version");
}
