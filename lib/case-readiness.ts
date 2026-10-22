// Rule-based readiness for the CA dashboard (Stage 5.10). Shapes mirror
// case_review.readiness_view. These are checklist facts from stored data,
// never a judgement that a case is tax-ready or complete.

export type CaseReadiness = {
  statement: "none" | "not_prepared" | "unverified" | "verified";
  unverified_reasons: string[];
  documents: {
    required_outstanding: number;
    required_received: number;
    required_waived: number;
    optional_outstanding: number;
    total_requests: number;
  };
  /** Valid transactions of the current review still awaiting a CA decision (to confirm or to classify). */
  transactions_to_review: number;
};

export const STATEMENT_LABELS: Record<CaseReadiness["statement"], string> = {
  none: "No usable statement",
  not_prepared: "Review not prepared",
  unverified: "Review unverified",
  verified: "Review verified",
};

export const STATEMENT_TONES: Record<CaseReadiness["statement"], string> = {
  none: "bg-paper-deep text-ink-soft",
  not_prepared: "bg-paper-deep text-ink-soft",
  unverified: "bg-amber-wash text-amber-ink",
  verified: "bg-teal-wash text-teal-deep",
};

// Flagged: the statement review is unverified, or a required document is
// still outstanding. Closed cases are never flagged.
export function needsAttention(status: string, r: CaseReadiness): boolean {
  return status !== "closed" && (r.statement === "unverified" || r.documents.required_outstanding > 0);
}

// What the CA should do next. Before a review exists there is one step; after
// that every pending action is named (transactions to decide, an unverified
// statement, required documents outstanding), and with none pending the case
// is ready for the workbook. Facts from stored data, not a tax judgement.
export function nextAction(status: string, r: CaseReadiness): string {
  if (status === "closed") return "Closed";
  if (r.statement === "none") return "Wait for the client's statement";
  if (r.statement === "not_prepared") return "Prepare the statement review";
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const actions: string[] = [];
  if (r.transactions_to_review > 0) actions.push(`review ${plural(r.transactions_to_review, "transaction")} awaiting a decision`);
  if (r.statement === "unverified") actions.push("check the unverified statement");
  if (r.documents.required_outstanding > 0) {
    actions.push(`follow up on ${plural(r.documents.required_outstanding, "required document")}`);
  }
  if (!actions.length) return "No pending actions: download the ITR summary workbook";
  const text = actions.length === 1 ? actions[0] : `${actions.slice(0, -1).join(", ")} and ${actions[actions.length - 1]}`;
  return text[0].toUpperCase() + text.slice(1);
}
