// The CA dashboard's priority queue: open cases ordered by what holds them up.
// Built only from what the dashboard already has (case status, readiness,
// intake progress and the firm's statement uploads) and reusing
// needsAttention; it never changes a case or its status. Like readiness, these
// are facts from stored data, not a judgement that a return is ready to file.

import { needsAttention, type CaseReadiness } from "./case-readiness";
import type { IntakeProgress } from "./intake";

export type Priority = 1 | 2 | 3 | 4 | 5;

export const PRIORITY_GROUPS: Record<Priority, { title: string; detail: string }> = {
  1: { title: "Blocked", detail: "An unverified or unusable statement, or required documents outstanding." },
  2: { title: "Decisions waiting", detail: "Transactions to confirm or classify." },
  3: { title: "Review to prepare", detail: "A usable statement is in; prepare its review." },
  4: { title: "Waiting for the client", detail: "No usable statement yet, or the client's intake is incomplete." },
  5: { title: "Ready for the workbook", detail: "Nothing pending in the stored data." },
};

export type QueueCase = {
  reference: string;
  status: string;
  updated_at: string;
  readiness: CaseReadiness;
  intake: IntakeProgress;
};

/** Upload statuses that leave nothing to review. */
const UNUSABLE_UPLOADS = new Set(["rejected", "processing_failed"]);

/**
 * The case's place in the queue, or null for a closed case (closed cases are not queued).
 * `uploadStatuses` are the statuses of the case's statement uploads.
 */
export function casePriority(c: QueueCase, uploadStatuses: string[] = []): Priority | null {
  if (c.status === "closed") return null;
  const r = c.readiness;
  const unusableUpload = r.statement === "none" && uploadStatuses.some((s) => UNUSABLE_UPLOADS.has(s));
  if (needsAttention(c.status, r) || unusableUpload) return 1;
  if (r.transactions_to_review > 0) return 2;
  if (r.statement === "not_prepared") return 3;
  if (r.statement === "none" || !c.intake.complete) return 4;
  return 5;
}

export type PendingKey = "unverified" | "unusable" | "documents" | "transactions" | "prepare" | "statement" | "details";

/** What is still open on the case, most pressing first, with a stable key for linking to where it is handled. */
export function pendingItems(c: QueueCase, uploadStatuses: string[] = []): { key: PendingKey; label: string }[] {
  const r = c.readiness;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const items: { key: PendingKey; label: string }[] = [];
  if (r.statement === "unverified") items.push({ key: "unverified", label: "Statement review unverified" });
  if (r.statement === "none" && uploadStatuses.some((s) => UNUSABLE_UPLOADS.has(s))) {
    items.push({ key: "unusable", label: "Uploaded statement could not be used" });
  }
  if (r.documents.required_outstanding > 0) {
    items.push({ key: "documents", label: `${plural(r.documents.required_outstanding, "required document")} outstanding` });
  }
  if (r.transactions_to_review > 0) {
    items.push({ key: "transactions", label: `${plural(r.transactions_to_review, "transaction")} to decide` });
  }
  if (r.statement === "not_prepared") items.push({ key: "prepare", label: "Review not prepared" });
  if (r.statement === "none" && !items.length) items.push({ key: "statement", label: "No usable statement yet" });
  if (!c.intake.steps.find((s) => s.key === "details")?.done) items.push({ key: "details", label: "Client details incomplete" });
  return items;
}

/** Short facts behind the case's place in the queue, most pressing first. */
export function priorityReasons(c: QueueCase, uploadStatuses: string[] = []): string[] {
  return pendingItems(c, uploadStatuses).map((item) => item.label);
}

export type QueueEntry<C extends QueueCase> = { case: C; priority: Priority; reasons: string[] };

/**
 * Open cases in queue order: by priority; then more required documents outstanding; then more transactions
 * to decide; then the case untouched longest (oldest update); then reference. The order is total, so the
 * same data always gives the same queue.
 */
export function priorityQueue<C extends QueueCase>(cases: C[], uploads: { case_reference: string; status: string }[] = []):
  QueueEntry<C>[] {
  const statuses = new Map<string, string[]>();
  for (const u of uploads) statuses.set(u.case_reference, [...(statuses.get(u.case_reference) ?? []), u.status]);
  return cases
    .map((c) => {
      const own = statuses.get(c.reference) ?? [];
      const priority = casePriority(c, own);
      return priority === null ? null : { case: c, priority, reasons: priorityReasons(c, own) };
    })
    .filter((e): e is QueueEntry<C> => e !== null)
    .sort((a, b) =>
      a.priority - b.priority
      || b.case.readiness.documents.required_outstanding - a.case.readiness.documents.required_outstanding
      || b.case.readiness.transactions_to_review - a.case.readiness.transactions_to_review
      || a.case.updated_at.localeCompare(b.case.updated_at)
      || a.case.reference.localeCompare(b.case.reference));
}
