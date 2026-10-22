import Link from "next/link";
import { CASE_TAB_LABELS, CASE_TABS, caseTabHref, type CaseTab } from "@/lib/case-tabs";
import { RevealCurrentTab } from "./RevealCurrentTab";
import { TabPendingHint } from "./TabPendingHint";

// The case sections as links, so each is a real URL: the browser's back and
// forward move between them and a refresh keeps the section. Marked up as
// navigation (aria-current), not as an ARIA tab list, because each choice
// loads a page. On a phone the bar scrolls sideways if the names do not fit.
// While a section loads, its tab shows a pulsing bar (TabPendingHint).
export function CaseTabs({ reference, current, counts }: {
  reference: string;
  current: CaseTab;
  /** Optional pending counts shown beside a tab name, e.g. transactions still to decide. */
  counts?: Partial<Record<CaseTab, number>>;
}) {
  return (
    <nav aria-label="Case sections"
         className="sticky top-14 z-30 -mx-4 mt-6 border-b border-line bg-paper/95 px-4 backdrop-blur sm:-mx-6 sm:px-6">
      <ul className="-mb-px flex overflow-x-auto sm:gap-1">
        {CASE_TABS.map((tab) => {
          const selected = tab === current;
          const count = counts?.[tab];
          return (
            <li key={tab} className="shrink-0">
              <Link href={caseTabHref(reference, tab)} aria-current={selected ? "page" : undefined}
                    className={`relative flex items-center gap-1.5 border-b-2 px-[7px] py-3 text-[13px] transition-colors sm:gap-2 sm:px-3 sm:text-sm ${selected
                      ? "border-accent font-semibold text-ink" : "border-transparent text-ink-soft hover:text-ink"}`}>
                {CASE_TAB_LABELS[tab]}
                {count ? (
                  <span className="rounded-full bg-warning-bg px-1.5 py-px text-xs font-medium tabular-nums text-warning-fg">
                    {count}<span className="sr-only"> pending</span>
                  </span>
                ) : null}
                {!selected && <TabPendingHint />}
              </Link>
            </li>
          );
        })}
      </ul>
      <RevealCurrentTab />
    </nav>
  );
}
