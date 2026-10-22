// Case status labels for CA pages (statuses from the `cases.status` CHECK constraint).
export const CASE_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  statement_uploaded: "Statement uploaded",
  processing: "Processing",
  questions_in_progress: "Questions in progress",
  documents_pending: "Documents pending",
  submitted: "Submitted",
  ca_review_required: "CA review required",
  review_ready: "Ready for review",
  closed: "Closed",
};
