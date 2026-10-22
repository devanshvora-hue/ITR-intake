// The suggested document checklist: deterministic rules over what the client
// declared on their profile and what the CA-prepared review classified with
// high or medium confidence. No model, no tax computation: each rule names a
// document a CA commonly asks for in that situation, explains why in plain
// words and says how sure it is. Weak evidence never produces a "likely
// needed" item, and deductions are always "only if it applies" for the CA to
// confirm.
//
// Suggestions are stored in checklist_items, one row per (case, rule key), so
// a refresh updates rows in place and keeps the client's answers. A rule that
// no longer fires marks its row `applies = false` instead of deleting it.
// Nothing here creates a document request except the CA's explicit "request"
// action.

import {
  type CaChecklistItem, type CaChecklistStatus, type ChecklistEvidence, type ChecklistLevel, type ClientChecklistItem,
  type ClientResponse, type IncomeSource, MAX_RESPONSE_NOTE,
} from "../checklist";
import { recordAudit } from "./audit";
import { syncCaseStatus } from "./case-status";
import type { CaseRow } from "./client-auth";
import type { Db } from "./db";
import { guarded } from "./errors";
import { isId } from "./ids";

export const CHECKLIST_RULES_VERSION = "checklist/1";

// Only these classifier confidences count as evidence.
const EVIDENCE_CONFIDENCES = ["high", "medium"];

export type ChecklistFacts = {
  financialYear: string;
  declared: ReadonlySet<string>;
  /** Category -> number of valid rows classified with high or medium confidence. */
  detected: ReadonlyMap<string, number>;
};

export type Suggestion = { key: string; label: string; reason: string; level: ChecklistLevel; evidence: ChecklistEvidence[] };

type Rule = {
  key: string;
  label: string;
  /** The profile code that makes the document likely (or conditional, see declaredLevel). */
  declared?: IncomeSource;
  declaredLevel?: ChecklistLevel;
  declaredReason?: (fy: string) => string;
  /** Categories that suggest the document when the client has not declared it. */
  categories?: string[];
  detectedLevel?: ChecklistLevel;
  detectedReason?: (fy: string) => string;
  /** Suggested alongside another rule that fired (a companion document). */
  companionOf?: string;
  companionLevel?: ChecklistLevel;
  companionReason?: (fy: string) => string;
  /** Always suggested (general, optional). */
  always?: { level: ChecklistLevel; reason: (fy: string) => string };
};

const RULES: Rule[] = [
  {
    key: "form_16", label: "Form 16 from your employer",
    declared: "salary", declaredLevel: "required",
    declaredReason: (fy) => `You told us you received salary or pension. Form 16 is the certificate your employer issues for FY ${fy}, showing salary paid and tax deducted.`,
    categories: ["Salary / Pension"], detectedLevel: "conditional",
    detectedReason: (fy) => `Your bank statement shows what look like salary or pension credits. If you were employed in FY ${fy}, your CA will usually need your employer's Form 16.`,
  },
  {
    key: "salary_slips", label: "Salary slips", companionOf: "form_16", companionLevel: "optional",
    companionReason: () => "Payslips help your CA cross-check the figures on Form 16, such as allowances.",
  },
  {
    key: "deposit_interest_certificate", label: "Interest certificate for fixed or recurring deposits",
    categories: ["Interest – FD / RD / Others"], detectedLevel: "conditional",
    detectedReason: (fy) => `Your bank statement shows interest that looks like it comes from deposits. The bank's interest certificate for FY ${fy} shows the full interest and any tax deducted.`,
  },
  {
    key: "capital_gains_statement", label: "Capital gains statement (and sale papers for any property sold)",
    declared: "capital_gains", declaredLevel: "required",
    declaredReason: () => "You told us you sold shares, mutual funds or property. Your broker's or fund registrar's capital gains statement lists each sale; for property, the sale deed is needed.",
    categories: ["Sale / Redemption of Investments"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like sale or redemption proceeds from investments. If you sold investments, your broker's or fund registrar's capital gains statement will help.",
  },
  {
    key: "dividend_statement", label: "Dividend statement",
    categories: ["Dividend"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like dividends. A dividend statement from your broker or the companies shows amounts and any tax deducted.",
  },
  {
    key: "rental_records", label: "Rent agreement and record of rent received",
    declared: "rental", declaredLevel: "required",
    declaredReason: () => "You told us you earn rent from a property you own. The rent agreement and a record of rent received let your CA report it.",
    categories: ["Rent Received"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like rent receipts. If you let out a property, the rent agreement and a record of rent received will help.",
  },
  {
    key: "municipal_tax_receipts", label: "Property tax receipts for the let-out property", companionOf: "rental_records",
    companionLevel: "optional",
    companionReason: () => "If you paid property tax to the municipality for a let-out property, the receipts may be useful to your CA.",
  },
  {
    key: "home_loan_certificate", label: "Home loan interest certificate from your lender",
    declared: "home_loan", declaredLevel: "required",
    declaredReason: (fy) => `You told us you are repaying a home loan. The lender's certificate for FY ${fy} shows interest and principal paid; your CA will confirm how it is used.`,
    categories: ["Loan EMI / Repayment"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows loan EMIs. Only if any of them are for a home loan, the lender's interest certificate will help; your CA will confirm whether it is relevant.",
  },
  {
    key: "tax_saving_proofs", label: "Proofs of tax-saving investments (e.g. PPF, ELSS, life insurance premiums)",
    declared: "tax_saving", declaredLevel: "conditional",
    declaredReason: () => "You told us you made tax-saving investments or paid insurance premiums. Your CA will confirm which of them can be used, so share proofs only for those that apply.",
    categories: ["Investments – Tax-saving"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like tax-saving investments. Your CA will confirm whether they are relevant before you collect proofs.",
  },
  {
    key: "health_insurance_receipts", label: "Health insurance premium receipts",
    declared: "tax_saving", declaredLevel: "conditional",
    declaredReason: () => "You told us you may have paid health insurance premiums. Receipts help if your CA confirms they are relevant.",
    categories: ["Insurance – Health"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like health insurance premiums. Receipts help if your CA confirms they are relevant.",
  },
  {
    key: "donation_receipts", label: "Donation receipts",
    categories: ["Donations"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like donations. Receipts from the organisations help if your CA confirms they are relevant.",
  },
  {
    key: "tax_payment_challans", label: "Challans for tax you paid yourself",
    categories: ["Tax Payments"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like income tax payments. The challans (payment receipts) for advance or self-assessment tax let your CA account for them.",
  },
  {
    key: "business_records", label: "Business or professional income and expense records",
    declared: "business", declaredLevel: "required",
    declaredReason: () => "You told us you have business, freelance or professional income. Your books, or a summary of receipts and expenses with invoices, let your CA work out that income.",
    categories: ["Business / Professional Receipts"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like business or professional receipts. If you had such income, a summary of receipts and expenses will help.",
  },
  {
    key: "loan_documents", label: "Loan agreements or confirmations for loans received or repaid to you",
    categories: ["Loans Received / Repayment of Loans Given"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows what look like loans received or loans repaid to you. A short confirmation or agreement helps your CA explain these amounts.",
  },
  {
    key: "gift_details", label: "Details of gifts or receipts from people outside your family",
    categories: ["Gifts / Receipts from Non-relatives"], detectedLevel: "conditional",
    detectedReason: () => "Your bank statement shows receipts that may be gifts from people outside your family. Brief details (who and why) help your CA understand them.",
  },
  {
    key: "other_bank_statements", label: "Statements for your other bank accounts",
    always: { level: "optional",
      reason: (fy) => `If you held other bank accounts in FY ${fy}, their statements help your CA see all interest and transactions. Skip this if this is your only account.` },
  },
];

const LEVEL_RANK: Record<ChecklistLevel, number> = { required: 3, conditional: 2, optional: 1 };

/** The suggestions for a case's facts, in a stable order. Pure and deterministic. */
export function evaluateChecklist(facts: ChecklistFacts): Suggestion[] {
  const fired = new Map<string, Suggestion>();
  for (const rule of RULES) {
    const candidates: { level: ChecklistLevel; reason: string; evidence: ChecklistEvidence }[] = [];
    if (rule.declared && facts.declared.has(rule.declared)) {
      candidates.push({ level: rule.declaredLevel!, reason: rule.declaredReason!(facts.financialYear),
        evidence: { source: "profile", code: rule.declared } });
    }
    const statementEvidence: ChecklistEvidence[] = (rule.categories ?? [])
      .filter((c) => (facts.detected.get(c) ?? 0) > 0)
      .map((c) => ({ source: "statement", category: c, rows: facts.detected.get(c)! }));
    if (statementEvidence.length) {
      candidates.push({ level: rule.detectedLevel!, reason: rule.detectedReason!(facts.financialYear),
        evidence: statementEvidence[0] });
    }
    if (rule.companionOf && fired.has(rule.companionOf)) {
      candidates.push({ level: rule.companionLevel!, reason: rule.companionReason!(facts.financialYear),
        evidence: fired.get(rule.companionOf)!.evidence[0] });
    }
    if (rule.always) candidates.push({ level: rule.always.level, reason: rule.always.reason(facts.financialYear),
      evidence: { source: "general" } });
    if (!candidates.length) continue;
    // The strongest reason explains the item; all evidence is kept for the CA.
    const best = candidates.reduce((a, b) => (LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a));
    const evidence = [...candidates.map((c) => c.evidence), ...statementEvidence.slice(1)];
    fired.set(rule.key, { key: rule.key, label: rule.label, reason: best.reason, level: best.level, evidence });
  }
  return [...fired.values()];
}

/** The facts for a case from its profile and its current review's rows. */
export async function checklistFacts(db: Db, firmId: string, caseId: string): Promise<ChecklistFacts | null> {
  const [c] = await db.query<{ financial_year: string; profile_json: Record<string, unknown>; reviewed_upload_id: string | null }>(
    "SELECT financial_year, profile_json, reviewed_upload_id FROM cases WHERE id = $1 AND firm_id = $2", [caseId, firmId]);
  if (!c) return null;
  const sources = Array.isArray(c.profile_json?.income_sources) ? c.profile_json.income_sources as unknown[] : [];
  const detected = new Map<string, number>();
  if (c.reviewed_upload_id !== null) {
    const rows = await db.query<{ category: string; n: number }>(
      `SELECT category, count(*)::int AS n FROM statement_rows
       WHERE case_id = $1 AND firm_id = $2 AND is_valid AND category IS NOT NULL AND confidence = ANY($3::text[])
       GROUP BY category`, [caseId, firmId, EVIDENCE_CONFIDENCES]);
    for (const r of rows) detected.set(r.category, r.n);
  }
  return { financialYear: c.financial_year, declared: new Set(sources.filter((s): s is string => typeof s === "string")),
    detected };
}

/**
 * Recompute the case's suggestions and store them (inside the caller's
 * transaction when given one). Existing rows keep their client answers and CA
 * status; rules that no longer fire are marked as not applying.
 */
export async function refreshChecklist(db: Db, firmId: string, caseId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const facts = await checklistFacts(tx, firmId, caseId);
    if (!facts) return;
    const suggestions = evaluateChecklist(facts);
    for (const s of suggestions) {
      await guarded(() => tx.query(
        `INSERT INTO checklist_items (case_id, firm_id, key, label, reason, level, evidence_json, rules_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8)
         ON CONFLICT (case_id, key) DO UPDATE SET label = EXCLUDED.label, reason = EXCLUDED.reason, level = EXCLUDED.level,
           evidence_json = EXCLUDED.evidence_json, rules_version = EXCLUDED.rules_version, applies = true,
           updated_at = now()
         WHERE checklist_items.firm_id = EXCLUDED.firm_id`,
        [caseId, firmId, s.key, s.label, s.reason, s.level, JSON.stringify(s.evidence), CHECKLIST_RULES_VERSION]),
      "checklist_item");
    }
    await tx.query(
      `UPDATE checklist_items SET applies = false, updated_at = now()
       WHERE case_id = $1 AND firm_id = $2 AND applies AND NOT (key = ANY($3::text[]))`,
      [caseId, firmId, suggestions.map((s) => s.key)]);
  });
}

type ItemRow = { id: string; case_id: string; key: string; label: string; reason: string; level: ChecklistLevel;
  evidence_json: ChecklistEvidence[]; applies: boolean; client_response: ClientResponse | null; client_note: string | null;
  responded_at: Date | null; ca_status: CaChecklistStatus; request_id: string | null; created_at: Date };

const RULE_INDEX = new Map(RULES.map((r, i) => [r.key, i]));

/** Likely needed first, then conditional, then optional; within a level, in rule order. */
function ordered(rows: ItemRow[]): ItemRow[] {
  return [...rows].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]
    || (RULE_INDEX.get(a.key) ?? RULES.length) - (RULE_INDEX.get(b.key) ?? RULES.length) || a.key.localeCompare(b.key));
}

/** Open suggestions for the client: never requested or dismissed items, never evidence. */
export async function clientChecklistView(db: Db, firmId: string, caseId: string): Promise<ClientChecklistItem[]> {
  const rows = await db.query<ItemRow>(
    `SELECT * FROM checklist_items WHERE case_id = $1 AND firm_id = $2 AND applies AND ca_status = 'suggested'`,
    [caseId, firmId]);
  return ordered(rows).map((r) => ({ id: r.id, label: r.label, reason: r.reason, level: r.level, response: r.client_response,
    note: r.client_note }));
}

/** Every current suggestion plus anything the CA has acted on. */
export async function caChecklistView(db: Db, firmId: string, caseId: string): Promise<CaChecklistItem[]> {
  const rows = await db.query<ItemRow>(
    `SELECT * FROM checklist_items WHERE case_id = $1 AND firm_id = $2 AND (applies OR ca_status <> 'suggested')`,
    [caseId, firmId]);
  return ordered(rows).map((r) => ({ id: r.id, key: r.key, label: r.label, reason: r.reason, level: r.level,
    evidence: r.evidence_json, applies: r.applies, response: r.client_response, note: r.client_note,
    responded_at: r.responded_at?.toISOString() ?? null, status: r.ca_status, request_id: r.request_id }));
}

/** A refused checklist action; `code` is fixed and nothing was changed. */
export class ChecklistRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChecklistRefused";
  }
}

async function lockedItem(tx: Db, firmId: string, caseId: string, itemId: unknown): Promise<ItemRow | null> {
  if (!isId(itemId)) return null;
  const [row] = await tx.query<ItemRow>(
    "SELECT * FROM checklist_items WHERE id = $1 AND case_id = $2 AND firm_id = $3 FOR UPDATE", [itemId, caseId, firmId]);
  return row ?? null;
}

function cleanNote(note: unknown): string | null {
  if (note === null || note === undefined) return null;
  if (typeof note !== "string") throw new ChecklistRefused("invalid_note");
  const value = note.replace(/\s+/g, " ").trim();
  if (value.length > MAX_RESPONSE_NOTE || /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(value)) throw new ChecklistRefused("invalid_note");
  return value || null;
}

/**
 * The client's answer to an open suggestion ("unavailable", "not_applicable",
 * or null to clear it), with an optional short note. Returns false for an item
 * outside the case.
 */
export async function setClientResponse(db: Db, input: { firmId: string; caseRow: CaseRow; actorId: string;
  itemId: unknown; response: ClientResponse | null; note: unknown }): Promise<boolean> {
  const { firmId, caseRow } = input;
  const note = input.response === null ? null : cleanNote(input.note);
  if (input.response === null && input.note !== null && input.note !== undefined && input.note !== "") {
    throw new ChecklistRefused("invalid_note");
  }
  return db.transaction(async (tx) => {
    const item = await lockedItem(tx, firmId, caseRow.id, input.itemId);
    if (!item) return false;
    if (caseRow.status === "closed") throw new ChecklistRefused("case_closed");
    if (!item.applies || item.ca_status !== "suggested") throw new ChecklistRefused("item_closed");
    await tx.query(
      `UPDATE checklist_items SET client_response = $4, client_note = $5,
         responded_at = CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, updated_at = now()
       WHERE id = $1 AND case_id = $2 AND firm_id = $3`, [item.id, caseRow.id, firmId, input.response, note]);
    await recordAudit(tx, { actorKind: "client", actorId: input.actorId, firmId, caseId: caseRow.id,
      action: "checklist.client_responded", details: { item_id: item.id, response: input.response } });
    return true;
  });
}

/**
 * The CA's decision on a suggestion: "request" turns it into a document
 * request (source 'rules') through the normal request workflow; "dismiss" hides
 * it from the client; "restore" undoes a dismissal. Returns false for an item
 * outside the case.
 */
export async function caChecklistAction(db: Db, input: { firmId: string; caseRow: CaseRow; actorId: string;
  itemId: unknown; action: "request" | "dismiss" | "restore" }): Promise<boolean> {
  const { firmId, caseRow, action } = input;
  return guarded(() => db.transaction(async (tx) => {
    const item = await lockedItem(tx, firmId, caseRow.id, input.itemId);
    if (!item) return false;
    if (caseRow.status === "closed") throw new ChecklistRefused("case_closed");
    const from = item.ca_status;
    let requestId: string | null = null;
    if (action === "request") {
      if (from !== "suggested") throw new ChecklistRefused("invalid_transition");
      if (!item.applies) throw new ChecklistRefused("item_closed");
      const [request] = await tx.query<{ id: string }>(
        `INSERT INTO document_requests (case_id, firm_id, key, label, description, required, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'rules') RETURNING id`,
        [caseRow.id, firmId, `checklist_${item.key}`, item.label, item.reason, item.level === "required"]);
      requestId = request.id;
      await tx.query(
        "UPDATE checklist_items SET ca_status = 'requested', request_id = $4, updated_at = now() WHERE id = $1 AND case_id = $2 AND firm_id = $3",
        [item.id, caseRow.id, firmId, requestId]);
      await syncCaseStatus(tx, firmId, caseRow.id);
    } else {
      const expected = action === "dismiss" ? "suggested" : "dismissed";
      if (from !== expected) throw new ChecklistRefused("invalid_transition");
      await tx.query(
        "UPDATE checklist_items SET ca_status = $4, updated_at = now() WHERE id = $1 AND case_id = $2 AND firm_id = $3",
        [item.id, caseRow.id, firmId, action === "dismiss" ? "dismissed" : "suggested"]);
    }
    await recordAudit(tx, { actorKind: "ca", actorId: input.actorId, firmId, caseId: caseRow.id,
      action: `checklist.item_${action === "request" ? "requested" : action === "dismiss" ? "dismissed" : "restored"}`,
      details: { item_id: item.id, ...(requestId ? { request_id: requestId } : {}) } });
    return true;
  }), "checklist_item");
}
