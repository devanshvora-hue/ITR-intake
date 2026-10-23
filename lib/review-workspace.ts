// The transaction review workspace's rules, kept apart from the component so
// they can be tested without a browser: which rows a filter and search show
// (unchanged from the earlier table), which row is selected, how the keyboard
// moves the selection, and what an unsaved edit is. No classification or
// review status is decided here; those come from the API.

import { postJson } from "./api-client";
import type { CaseReview, ReviewRow } from "./case-review";

// The 28 categories of the specification, in its order.
export const CATEGORY_OPTIONS = [
  "Salary / Pension", "Business / Professional Receipts", "Rent Received", "Interest – Savings Bank",
  "Interest – FD / RD / Others", "Dividend", "Sale / Redemption of Investments", "Income Tax Refund",
  "Loans Received / Repayment of Loans Given", "Gifts / Receipts from Non-relatives", "Investments – Tax-saving",
  "Investments – Others", "Insurance – Health", "Loan EMI / Repayment", "Loans Given", "Tax Payments", "Donations",
  "Credit Card Payments", "Rent Paid", "Business / Professional Expenses", "Self Transfer", "Family Transfer",
  "Cash Withdrawal", "Cash Deposit", "Personal Expenses", "Bank Charges", "Reversals / Refunds", "Others – Needs Review",
];

export type Filter = "all" | "needs" | "auto" | "reviewed" | "rejected";
export const FILTERS: [Filter, string][] = [
  ["needs", "Needs review"], ["all", "All"], ["auto", "Auto-classified"], ["reviewed", "Reviewed by CA"], ["rejected", "Rejected"],
];

export const GROUP_LABELS: Record<ReviewRow["group"], string> = {
  auto: "Auto-classified",
  confirm: "Confirm category",
  manual: "Classify manually",
  reviewed: "Reviewed by CA",
  rejected: "Not read",
};

export function filterCounts(review: CaseReview): Record<Filter, number> {
  const t = review.totals;
  return { all: review.rows.length, needs: t.confirm + t.manual, auto: t.auto, reviewed: t.reviewed, rejected: t.rejected };
}

/** The review queue when anything is waiting, otherwise everything. */
export function defaultFilter(review: CaseReview): Filter {
  return review.totals.confirm + review.totals.manual > 0 ? "needs" : "all";
}

export function matches(row: ReviewRow, filter: Filter, query: string): boolean {
  if (filter === "needs" && row.group !== "confirm" && row.group !== "manual") return false;
  if (filter === "auto" && row.group !== "auto") return false;
  if (filter === "reviewed" && row.group !== "reviewed") return false;
  if (filter === "rejected" && row.group !== "rejected") return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return [row.narration, row.counterparty, row.category].some((v) => v?.toLowerCase().includes(q));
}

/** Rows shown for a filter and search, in the review's own order. */
export function visibleRows(rows: ReviewRow[], filter: Filter, query: string): ReviewRow[] {
  const q = query.trim();
  return rows.filter((r) => matches(r, filter, q));
}

/** Where the selection moves for a navigation key, or undefined for keys the list ignores. Does not wrap. */
export function moveSelection(shown: ReviewRow[], current: number | null, key: string): number | null | undefined {
  if (!shown.length) return undefined;
  const at = shown.findIndex((r) => r.row_number === current);
  if (key === "Home") return shown[0].row_number;
  if (key === "End") return shown[shown.length - 1].row_number;
  if (key === "ArrowDown") return shown[at < 0 ? 0 : Math.min(at + 1, shown.length - 1)].row_number;
  if (key === "ArrowUp") return shown[at < 0 ? 0 : Math.max(at - 1, 0)].row_number;
  return undefined;
}

/**
 * The row to select once a decision on `saved` is stored: the next row in the list as it stood, else the
 * previous one, else the saved row itself. Lets the CA work down the queue; the saved row may leave it.
 */
export function selectionAfterSave(shown: ReviewRow[], saved: number): number {
  const at = shown.findIndex((r) => r.row_number === saved);
  if (at < 0) return saved;
  return (shown[at + 1] ?? shown[at - 1] ?? shown[at]).row_number;
}

export type Draft = { category: string; note: string };

/** What the editor starts from: the category in force and the CA's own note. */
export function savedValues(row: ReviewRow): Draft {
  return { category: row.category ?? "Others – Needs Review", note: row.decision?.note ?? "" };
}

/** True when the CA has changed the editor without saving. */
export function isDirty(row: ReviewRow, draft: Draft | undefined): boolean {
  if (!draft) return false;
  const saved = savedValues(row);
  return draft.category !== saved.category || draft.note.trim() !== saved.note.trim();
}

/** Rows that take a category decision (not rows that could not be read). */
export function isDecidable(row: ReviewRow): boolean {
  return row.group !== "rejected";
}

export type SaveOutcome = { kind: "saved" } | { kind: "signed_out" } | { kind: "error"; message: string };

/**
 * Save (category) or undo (null) the CA's decision on one row, with the same request and messages as
 * before. A note is sent only with a category and only when not blank.
 */
export async function saveDecision(reference: string, rowNumber: number, category: string | null, note: string):
  Promise<SaveOutcome> {
  const result = await postJson(`/api/ca/cases/${encodeURIComponent(reference)}/review/rows/${rowNumber}`,
    { category, ...(category && note.trim() ? { note: note.trim() } : {}) });
  if (result.status === 401) return { kind: "signed_out" };
  if (!result.ok) {
    return { kind: "error", message: result.status === 0 ? "The server is not reachable. Try again."
      : String(result.data.message ?? "The change could not be saved.") };
  }
  return { kind: "saved" };
}
