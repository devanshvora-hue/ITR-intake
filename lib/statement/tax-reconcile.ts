// Reconciliation assistance between tax-report records (AIS / TIS / Form 26AS)
// and the reviewed bank statement. Deterministic: it proposes matches and
// differences for the CA to verify; it never decides tax treatment, never
// fills in a missing figure and never counts the same item twice.
//
// - A record repeated in another report (same category, date, amount and
//   payer) is a duplicate and is not matched again.
// - A dated record matches one unused bank credit of the same amount (or the
//   amount net of the tax deducted) within DATE_WINDOW days, preferring the
//   corresponding bank category; otherwise an equal amount further away is a
//   date difference, a same-category credit nearby is an amount difference,
//   and anything else is not found.
// - An undated record (an annual total) is compared with the total of unused
//   bank credits in the corresponding categories.
// - Each bank credit is used at most once. Bank credits in income categories
//   that no record accounts for are listed for the CA ("in bank only").
// - A CA verdict (confirmed / unresolved) applies only while the match is the
//   one the CA saw; if the match has since changed it is shown as stale.

import { formatPaise } from "./validation";
import type { TaxRecordCategory, TaxReportKind } from "./tax-report";

export const TAX_MATCH_SETTINGS = {
  dateWindowDays: 7,
  /** An equal amount up to this far away is reported as a date difference rather than not found. */
  farWindowDays: 45,
  /** Annual totals are compared to the paisa, allowing this rounding difference (₹1). */
  aggregateTolerance: 100n,
};

const BANK_CATEGORIES: Record<TaxRecordCategory, string[]> = {
  salary: ["Salary / Pension"],
  interest_savings: ["Interest – Savings Bank"],
  interest_deposit: ["Interest – FD / RD / Others"],
  interest_other: ["Interest – FD / RD / Others", "Interest – Savings Bank"],
  dividend: ["Dividend"],
  securities_sale: ["Sale / Redemption of Investments"],
  rent: ["Rent Received"],
  tax_refund: ["Income Tax Refund"],
  cash_deposit: ["Cash Deposit"],
  other: [],
};
const INCOME_CATEGORIES = ["Salary / Pension", "Interest – Savings Bank", "Interest – FD / RD / Others", "Dividend",
  "Rent Received", "Sale / Redemption of Investments", "Income Tax Refund"];

export type ReconRecordInput = {
  id: string; reportId: string; reportKind: TaxReportKind; reportOrder: number; sourceRow: number;
  category: TaxRecordCategory; description: string; party: string | null; date: string | null; amount: bigint;
  taxDeducted: bigint | null; reviewStatus: "confirmed" | "unresolved" | null; reviewedMatch: string | null;
};
export type BankCredit = { rowNumber: number; date: string; credit: bigint; category: string; narration: string };
export type MatchStatus = "matched" | "matched_net_of_tax" | "aggregate_matched" | "amount_differs" | "date_differs"
  | "not_found" | "not_compared" | "duplicate";
export type RecordResult = {
  id: string; status: MatchStatus; bankRows: number[]; bankAmount: bigint | null; difference: bigint | null;
  duplicateOf: string | null; signature: string;
  /** auto: matched or duplicate, nothing to do; open: needs the CA; confirmed / unresolved: the CA's verdict. */
  review: "auto" | "open" | "confirmed" | "unresolved"; staleReview: boolean;
};
export type CategorySummary = { category: TaxRecordCategory; reported: string; taxDeducted: string; bank: string;
  difference: string; records: number };
export type Reconciliation = {
  results: RecordResult[]; bankOnly: BankCredit[]; summary: CategorySummary[];
  status: "no_reports" | "complete" | "open"; openCount: number;
};

const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
const abs = (v: bigint) => (v < 0n ? -v : v);
const partyKey = (p: string | null) => (p ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function reconcileTaxReports(records: ReconRecordInput[], bank: BankCredit[]): Reconciliation {
  if (!records.length) return { results: [], bankOnly: [], summary: [], status: "no_reports", openCount: 0 };
  const s = TAX_MATCH_SETTINGS;
  const ordered = [...records].sort((a, b) => a.reportOrder - b.reportOrder || a.sourceRow - b.sourceRow);
  const used = new Set<number>();
  const outcome = new Map<string, Omit<RecordResult, "signature" | "review" | "staleReview">>();
  const set = (r: ReconRecordInput, status: MatchStatus, rows: BankCredit[] = [], bankAmount: bigint | null = null,
    difference: bigint | null = null, duplicateOf: string | null = null) => {
    rows.forEach((b) => used.add(b.rowNumber));
    outcome.set(r.id, { id: r.id, status, bankRows: rows.map((b) => b.rowNumber), bankAmount, difference, duplicateOf });
  };

  // 1. The same item reported in two reports is counted once.
  const firstByKey = new Map<string, ReconRecordInput>();
  const primary: ReconRecordInput[] = [];
  for (const r of ordered) {
    const key = [r.category, r.date ?? "", r.amount.toString(), partyKey(r.party)].join("|");
    const first = firstByKey.get(key);
    if (first && first.reportId !== r.reportId) set(r, "duplicate", [], null, null, first.id);
    else {
      if (!first) firstByKey.set(key, r);
      primary.push(r);
    }
  }

  // 2. Dated records, earliest first.
  const dated = primary.filter((r) => r.date && BANK_CATEGORIES[r.category].length)
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  for (const r of dated) {
    const mapped = BANK_CATEGORIES[r.category];
    const net = r.taxDeducted && r.taxDeducted > 0n && r.taxDeducted < r.amount ? r.amount - r.taxDeducted : null;
    const free = bank.filter((b) => !used.has(b.rowNumber));
    const gap = (b: BankCredit) => Math.abs(day(b.date) - day(r.date!));
    const rank = (list: BankCredit[]) => list.sort((a, b) =>
      Number(mapped.includes(b.category)) - Number(mapped.includes(a.category)) || gap(a) - gap(b) || a.rowNumber - b.rowNumber);
    const equal = (b: BankCredit) => b.credit === r.amount || (net !== null && b.credit === net);
    const near = rank(free.filter((b) => equal(b) && gap(b) <= s.dateWindowDays));
    if (near.length) {
      set(r, near[0].credit === r.amount ? "matched" : "matched_net_of_tax", [near[0]], near[0].credit, 0n);
      continue;
    }
    const far = rank(free.filter((b) => equal(b) && gap(b) <= s.farWindowDays));
    if (far.length) {
      set(r, "date_differs", [far[0]], far[0].credit, 0n);
      continue;
    }
    const sameKind = free.filter((b) => mapped.includes(b.category) && gap(b) <= s.dateWindowDays)
      .sort((a, b) => Number(abs(a.credit - r.amount) - abs(b.credit - r.amount)) || gap(a) - gap(b));
    if (sameKind.length) set(r, "amount_differs", [sameKind[0]], sameKind[0].credit, sameKind[0].credit - r.amount);
    else set(r, "not_found");
  }

  // 3. Annual totals (no date) against the remaining credits of the corresponding categories.
  for (const r of primary.filter((x) => !x.date && BANK_CATEGORIES[x.category].length)) {
    const pool = bank.filter((b) => !used.has(b.rowNumber) && BANK_CATEGORIES[r.category].includes(b.category));
    const total = pool.reduce((sum, b) => sum + b.credit, 0n);
    const net = r.taxDeducted && r.taxDeducted > 0n ? r.amount - r.taxDeducted : null;
    if (pool.length && (abs(total - r.amount) <= s.aggregateTolerance || (net !== null && abs(total - net) <= s.aggregateTolerance))) {
      set(r, "aggregate_matched", pool, total, total - r.amount);
    } else if (pool.length) {
      set(r, "amount_differs", [], total, total - r.amount);
    } else {
      set(r, "not_found");
    }
  }
  for (const r of primary) if (!outcome.has(r.id)) set(r, "not_compared");

  const results: RecordResult[] = ordered.map((r) => {
    const o = outcome.get(r.id)!;
    const signature = `${o.status}:${o.bankRows.join(",")}:${o.bankAmount ?? ""}`;
    const base = ["matched", "matched_net_of_tax", "aggregate_matched", "duplicate"].includes(o.status) ? "auto" : "open";
    const valid = r.reviewStatus !== null && r.reviewedMatch === signature;
    return { ...o, signature, review: valid ? r.reviewStatus! : base, staleReview: r.reviewStatus !== null && !valid };
  });

  const bankOnly = bank.filter((b) => !used.has(b.rowNumber) && INCOME_CATEGORIES.includes(b.category));
  const counted = ordered.filter((r) => outcome.get(r.id)!.status !== "duplicate");
  const summary = [...new Set(counted.map((r) => r.category))].map((category) => {
    const items = counted.filter((r) => r.category === category);
    const reported = items.reduce((sum, r) => sum + r.amount, 0n);
    const tax = items.reduce((sum, r) => sum + (r.taxDeducted ?? 0n), 0n);
    const bankTotal = bank.filter((b) => BANK_CATEGORIES[category].includes(b.category)).reduce((sum, b) => sum + b.credit, 0n);
    return { category, records: items.length, reported: formatPaise(reported), taxDeducted: formatPaise(tax),
      bank: formatPaise(bankTotal), difference: formatPaise(bankTotal - reported) };
  });
  const openCount = results.filter((r) => r.review === "open" || r.review === "unresolved").length;
  return { results, bankOnly, summary, status: openCount ? "open" : "complete", openCount };
}
