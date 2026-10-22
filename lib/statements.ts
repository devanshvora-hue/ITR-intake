// Shared types and plain-language labels for statement uploads (Stage 5.7).
// The server sends codes only (never transaction contents); these turn them
// into messages for clients and CAs.

export type StatementUpload = {
  id: string;
  file_type: "pdf" | "csv" | "unknown";
  display_name: string;
  size_bytes: number;
  status: "processing" | "extracted" | "manual_review_required" | "rejected" | "processing_failed";
  error_code: string | null;
  reasons: string[];
  page_warnings: { page: number; code: string }[];
  rejected_rows: { row: number; codes: string[]; page?: number }[];
  duplicate_rows: number[];
  pages_total: number | null;
  rows_extracted: number;
  rows_rejected: number;
  rows_duplicate: number;
  rows_summary: number;
  period_start: string | null;
  period_end: string | null;
  uploaded_at: string;
};

export const STATUS_LABELS: Record<StatementUpload["status"], string> = {
  processing: "Processing",
  extracted: "Extracted",
  manual_review_required: "Needs manual review",
  rejected: "Rejected",
  processing_failed: "Processing failed",
};

export const STATUS_TONES: Record<StatementUpload["status"], string> = {
  processing: "bg-paper-deep text-ink-soft",
  extracted: "bg-teal-wash text-teal-deep",
  manual_review_required: "bg-amber-wash text-amber-ink",
  rejected: "bg-rose-wash text-rose-ink",
  processing_failed: "bg-rose-wash text-rose-ink",
};

const MESSAGES: Record<string, string> = {
  // file-level
  empty_file: "The file is empty.",
  unsupported_file_type: "Only PDF and CSV files are accepted.",
  unsupported_content: "The file's contents are not a PDF or CSV.",
  type_mismatch: "The file's contents do not match its name or type.",
  file_too_large: "The file is too large.",
  truncated_pdf: "The PDF appears to be incomplete or damaged.",
  pdf_unreadable: "The PDF could not be read.",
  pdf_password_protected: "The PDF is password-protected. Please upload an unprotected copy.",
  pdf_copy_restricted: "The PDF does not allow its text to be read. Please download an unrestricted copy from your bank.",
  pdf_timeout: "The PDF took too long to read.",
  pdf_text_too_large: "The PDF contains too much text to process.",
  too_many_pages: "The PDF has too many pages.",
  too_many_rows: "The file has too many rows.",
  too_many_columns: "The CSV has too many columns.",
  unsupported_encoding: "The CSV must be saved as UTF-8 text.",
  unsupported_delimiter: "The CSV must use commas between columns.",
  malformed_csv: "The CSV is not well formed (for example, an unclosed quote).",
  missing_required_columns: "The CSV needs Date, Narration/Description and Debit or Credit columns.",
  no_data_rows: "The CSV has a header but no transactions.",
  no_pages: "The PDF has no pages.",
  unexpected_error: "Something went wrong while reading this file.",
  // review reasons
  rows_rejected: "Some rows could not be read and were not included.",
  duplicate_looking_rows: "Some rows look identical; they were kept for review.",
  balance_chain_broken: "Running balances do not add up, so rows may be missing or misread.",
  balance_chain_not_verifiable: "Balances could not be checked because some rows were rejected.",
  balance_column_missing: "No balance column was found, so completeness cannot be confirmed.",
  balance_missing_on_rows: "Some rows have no balance.",
  opening_balance_mismatch: "The opening balance printed on the statement does not match the first transaction.",
  closing_balance_mismatch: "The closing balance printed on the statement does not match the last transaction.",
  carried_forward_mismatch: "A balance carried forward between pages does not match the rows before it.",
  totals_mismatch: "The statement's printed totals do not match the rows that were read.",
  directions_from_balance: "Some amounts sat between columns; their debit/credit side was taken from the running balance and needs a check.",
  ambiguous_columns: "The amount could not be placed in the debit, credit or balance column.",
  direction_conflicts_with_balance: "The amount's column contradicts the running balance (debit/credit may be swapped).",
  dates_outside_financial_year: "Some dates are outside the selected financial year.",
  no_transactions_found: "No transactions were found.",
  unsupported_layout: "This statement layout is not supported for automatic reading.",
  pages_without_text: "Some pages have no readable text (they may be scanned images).",
  image_content_not_extracted: "Some content appears to be images, which are not read automatically.",
  unrecognised_lines: "Some lines with amounts could not be identified.",
  pdf_extractor_unavailable: "PDF reading is not available on this server.",
  // page warnings
  no_extractable_text: "no readable text",
  no_transaction_table: "no transaction table",
  no_transactions_on_page: "no transactions read",
  no_transactions_recognised: "no transactions read",
  unrecognised_amount_line: "unidentified amounts",
};

export function describe(code: string): string {
  return MESSAGES[code] ?? code.replaceAll("_", " ");
}

export function pagesByWarning(warnings: StatementUpload["page_warnings"]): string[] {
  const grouped = new Map<string, number[]>();
  for (const w of warnings) grouped.set(w.code, [...(grouped.get(w.code) ?? []), w.page]);
  return [...grouped].map(([code, pages]) => `Page${pages.length > 1 ? "s" : ""} ${pages.join(", ")}: ${describe(code)}`);
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
