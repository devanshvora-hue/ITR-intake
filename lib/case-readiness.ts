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

// The first rule that applies, in order. Each one names what to do next on
// the case page; the last one only says no checklist item is open.
export function nextAction(status: string, r: CaseReadiness): string {
  if (status === "closed") return "Closed";
  if (r.statement === "none") return "Wait for the client's statement";
  if (r.statement === "not_prepared") return "Prepare the statement review";
  if (r.statement === "unverified") return "Check the unverified review";
  if (r.documents.required_outstanding > 0) {
    const n = r.documents.required_outstanding;
    return `Follow up on ${n} required document${n === 1 ? "" : "s"}`;
  }
  if (r.documents.total_requests === 0) return "Request any supporting documents";
  return "No open checklist items";
}
