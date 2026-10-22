// The case page's sections. The selected one lives only in the URL
// (?tab=…), so a refresh, router.refresh() after a change, a shared link and
// back/forward all show the same section with no state to fall out of step.

export const CASE_TABS = ["overview", "transactions", "documents", "summary"] as const;
export type CaseTab = (typeof CASE_TABS)[number];

export const CASE_TAB_LABELS: Record<CaseTab, string> = {
  overview: "Overview",
  transactions: "Transactions",
  documents: "Documents",
  summary: "Summary",
};

/** The tab named by a ?tab= value; anything missing, repeated or unknown is the overview. */
export function parseCaseTab(value: string | string[] | undefined): CaseTab {
  return typeof value === "string" && (CASE_TABS as readonly string[]).includes(value) ? (value as CaseTab) : "overview";
}

export function caseTabHref(reference: string, tab: CaseTab): string {
  return `/ca/cases/${encodeURIComponent(reference)}?tab=${tab}`;
}
