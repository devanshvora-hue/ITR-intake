// Shared types and labels for the suggested document checklist (client and CA
// pages, and the server rules in lib/server/checklist.ts). An intake aid only:
// suggestions are not tax advice and never become document requests until the
// CA converts them.

export type ChecklistLevel = "required" | "conditional" | "optional";
export type ClientResponse = "unavailable" | "not_applicable";
export type CaChecklistStatus = "suggested" | "requested" | "dismissed";

/** Optional self-declared income situations on the client profile (fixed codes). */
export const INCOME_SOURCES = [
  { code: "salary", label: "Salary or pension" },
  { code: "rental", label: "Rent from a property I own" },
  { code: "capital_gains", label: "Sold shares, mutual funds or property" },
  { code: "business", label: "Business, freelance or professional income" },
  { code: "home_loan", label: "Repaying a home loan" },
  { code: "tax_saving", label: "Tax-saving investments or health insurance (e.g. PPF, ELSS, insurance premiums)" },
] as const;

export type IncomeSource = (typeof INCOME_SOURCES)[number]["code"];

export const LEVEL_LABELS: Record<ChecklistLevel, string> = {
  required: "Likely needed",
  conditional: "Only if it applies",
  optional: "Optional",
};

export const LEVEL_TONES: Record<ChecklistLevel, string> = {
  required: "bg-amber-wash text-amber-ink",
  conditional: "bg-paper-deep text-ink-soft",
  optional: "bg-paper-deep text-ink-faint",
};

export const RESPONSE_LABELS: Record<ClientResponse, string> = {
  unavailable: "I don't have this",
  not_applicable: "Doesn't apply to me",
};

export const CA_STATUS_LABELS: Record<CaChecklistStatus, string> = {
  suggested: "Suggested",
  requested: "Requested",
  dismissed: "Dismissed",
};

export const MAX_RESPONSE_NOTE = 300;

export type ChecklistEvidence =
  | { source: "profile"; code: string }
  | { source: "statement"; category: string; rows: number }
  | { source: "general" };

/** What the client sees: open suggestions only (requested items appear as document requests). */
export type ClientChecklistItem = {
  id: string;
  label: string;
  reason: string;
  level: ChecklistLevel;
  response: ClientResponse | null;
  note: string | null;
};

export type CaChecklistItem = ClientChecklistItem & {
  key: string;
  evidence: ChecklistEvidence[];
  applies: boolean;
  status: CaChecklistStatus;
  request_id: string | null;
  responded_at: string | null;
};

export const CHECKLIST_ERRORS: Record<string, string> = {
  case_closed: "This case is closed.",
  item_closed: "This suggestion has changed. Reload to see its current state.",
  invalid_transition: "This suggestion has already changed. Reload to see its current state.",
  document_request_exists: "A request for this document already exists.",
  rate_limited: "Too many attempts. Please try again later.",
};

export function checklistError(status: number, code: unknown, fallback: string): string {
  if (status === 0) return "The server is not reachable. Check your connection and try again.";
  if (status === 429) return CHECKLIST_ERRORS.rate_limited;
  return (typeof code === "string" && CHECKLIST_ERRORS[code]) || fallback;
}
