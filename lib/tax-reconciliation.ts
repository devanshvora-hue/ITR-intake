// Shapes and labels for the AIS / TIS / Form 26AS reconciliation on the CA case
// page (mirrors lib/server/tax-reports.ts taxReconciliation). Assistance for
// the CA, not a tax determination.

export type TaxReconRecord = {
  id: string; report_id: string; report_kind: string; source_row: number; category: string; description: string;
  party: string | null; date: string | null; amount: string; tax_deducted: string | null; status: string;
  bank_rows: number[]; bank_amount: string | null; difference: string | null; duplicate_of: string | null;
  review: "auto" | "open" | "confirmed" | "unresolved"; stale_review: boolean; note: string | null; signature: string;
};

export type TaxReconciliationView = {
  status: "no_reports" | "complete" | "open";
  open_count: number;
  review_prepared: boolean;
  reports: { id: string; kind: string; file_type: string; display_name: string; records_count: number;
    warnings: { row: number; code: string }[]; uploaded_at: string }[];
  records: TaxReconRecord[];
  bank_only: { row_number: number; date: string; amount: string; category: string; narration: string }[];
  summary: { category: string; reported: string; taxDeducted: string; bank: string; difference: string; records: number }[];
};

export const REPORT_KINDS: [string, string][] = [["ais", "AIS"], ["tis", "TIS"], ["form26as", "Form 26AS"]];
export const REPORT_KIND_LABELS: Record<string, string> = Object.fromEntries(REPORT_KINDS);

export const RECORD_CATEGORY_LABELS: Record<string, string> = {
  salary: "Salary", interest_savings: "Interest – savings", interest_deposit: "Interest – deposits",
  interest_other: "Interest – other", dividend: "Dividend", securities_sale: "Sale of securities / units", rent: "Rent",
  tax_refund: "Tax refund", cash_deposit: "Cash deposit", other: "Other",
};

export const MATCH_LABELS: Record<string, [string, string]> = {
  matched: ["Matched", "bg-teal-wash text-teal-deep"],
  matched_net_of_tax: ["Matched (net of TDS)", "bg-teal-wash text-teal-deep"],
  aggregate_matched: ["Matched (annual total)", "bg-teal-wash text-teal-deep"],
  amount_differs: ["Amount differs", "bg-amber-wash text-amber-ink"],
  date_differs: ["Date differs", "bg-amber-wash text-amber-ink"],
  not_found: ["Not in bank statement", "bg-rose-wash text-rose-ink"],
  not_compared: ["Not compared", "bg-paper-deep text-ink-soft"],
  duplicate: ["Duplicate (counted once)", "bg-paper-deep text-ink-soft"],
};

export const WARNING_LABELS: Record<string, string> = {
  missing_amount: "no amount", invalid_amount: "amount not readable", missing_description: "no description",
  invalid_tax_amount: "TDS amount not readable", invalid_date: "date not readable",
};
