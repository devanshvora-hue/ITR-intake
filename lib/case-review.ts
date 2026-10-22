// Types and labels for the CA case-detail page (Stage 5.8). Shapes mirror
// `GET /api/ca/cases/{reference}` (app.py `_ca_case_detail` and
// case_review.py `review_view`); nothing here is invented by the frontend.
import type { CaChecklistItem } from "./checklist";
import type { DocumentRequest } from "./document-requests";
import type { IntakeProgress } from "./intake";
import type { StatementUpload } from "./statements";

export type CaseInfo = {
  reference: string;
  financial_year: string;
  status: string;
  created_at: string;
  updated_at: string;
  client_first_name: string;
  client_email: string;
  client_email_verified: boolean;
  reviewed_at: string | null;
};

export type CaseProfile = {
  full_name: string | null;
  bank_name: string | null;
  account_last4: string | null;
  income_sources: string[];
  complete: boolean;
};

export type ReviewRow = {
  row_number: number;
  is_valid: boolean;
  issues: string[];
  date: string | null;
  narration: string | null;
  debit: string | null;
  credit: string | null;
  balance: string | null;
  category: string | null;
  confidence: string | null;
  review_status: string | null;
  flags: string[];
  classification_reason: string | null;
};

export type Reconciliation =
  | { status: "not_available" }
  | {
      status: "passed" | "failed" | "incomplete";
      opening_balance: string;
      expected_closing: string;
      stated_closing: string;
      difference: string;
    };

export type CaseReview = {
  statement: StatementUpload;
  prepared_at: string;
  classifier_version: string | null;
  period_start: string | null;
  period_end: string | null;
  verified: boolean;
  unverified_reasons: string[];
  totals: { rows: number; valid: number; invalid: number; needs_review: number; credits: string; debits: string };
  reconciliation: Reconciliation;
  rows: ReviewRow[];
};

export type CaseDetail = {
  case: CaseInfo;
  intake: IntakeProgress;
  profile: CaseProfile;
  statements: StatementUpload[];
  review: CaseReview | null;
  document_requests: DocumentRequest[];
  checklist: CaChecklistItem[];
};

// Upload outcomes the backend accepts for review preparation
// (case_review.PREPARABLE_UPLOAD_STATUSES).
export const PREPARABLE_STATUSES = new Set(["extracted", "manual_review_required"]);

export const UNVERIFIED_REASONS: Record<string, string> = {
  statement_needs_manual_review: "The statement itself needs manual review (its extraction was not fully confirmed).",
  rows_invalid: "Some rows could not be read and are not included in the totals.",
  balance_check_not_passed: "The running balance does not reconcile, or could not be checked.",
};

export const RECONCILIATION_LABELS: Record<string, string> = {
  passed: "Balances reconcile",
  failed: "Balances do not reconcile",
  incomplete: "Not checked: some rows are invalid",
  not_available: "Not checked: balances were not available",
};

// Codes `POST /api/ca/cases/{reference}/review` can return.
export const PREPARE_ERRORS: Record<string, { message: string; retry: boolean }> = {
  statement_not_usable: { message: "This statement cannot be reviewed (it was rejected or could not be read).", retry: false },
  file_missing: { message: "The stored file for this statement is missing. Ask the client to upload it again.", retry: false },
  file_unavailable: { message: "The stored file could not be opened safely.", retry: false },
  case_closed: { message: "This case is closed.", retry: false },
  invalid_case_status: { message: "A review cannot be prepared while the case is in its current status.", retry: false },
  stale_version: { message: "The case changed while preparing. Reload the page and try again.", retry: true },
  busy: { message: "The server is busy reading other statements. Try again in a minute.", retry: true },
  rate_limited: { message: "Too many review preparations for your firm. Try again later.", retry: true },
  pdf_extractor_unavailable: { message: "PDF reading is not available on this server.", retry: false },
  pdf_timeout: { message: "Reading the PDF took too long.", retry: true },
  pdf_unreadable: { message: "The PDF could not be read.", retry: false },
  pdf_copy_restricted: { message: "The PDF does not allow its text to be read.", retry: false },
  pdf_text_too_large: { message: "The PDF contains too much text to process.", retry: false },
  too_many_pages: { message: "The PDF has too many pages.", retry: false },
  not_found: { message: "This statement was not found in this case.", retry: false },
};
