import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import type { CaCase } from "@/lib/ca-session";
import { nextAction } from "@/lib/case-readiness";
import { PRIORITY_GROUPS, type Priority, type QueueEntry } from "@/lib/case-priority";
import { CASE_STATUS_LABELS } from "@/lib/case-status";

const GROUP_TONES: Record<Priority, string> = {
  1: "bg-warning-fg",
  2: "bg-accent",
  3: "bg-accent",
  4: "bg-ink-faint",
  5: "bg-success-fg",
};

// Open cases grouped by what holds them up, most pressing first (lib/case-priority.ts).
// Each card names the facts behind its place and the same next step as the case table.
export function PriorityQueue({ entries, hasCases }: { entries: QueueEntry<CaCase>[]; hasCases: boolean }) {
  const groups = ([1, 2, 3, 4, 5] as Priority[])
    .map((p) => ({ priority: p, entries: entries.filter((e) => e.priority === p) }))
    .filter((g) => g.entries.length > 0);

  return (
    <section aria-labelledby="queue" className="rounded-2xl border border-line bg-surface">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-4">
        <div>
          <h2 id="queue" className="text-lg font-semibold tracking-tight">Priority queue</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Open cases, blockers first. Ordered from stored data; not a judgement that a return is ready to file.
          </p>
        </div>
        <p className="text-xs text-ink-soft">{entries.length} open</p>
      </div>
      {groups.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-ink-soft">
          {hasCases ? "No open cases. Closed cases are listed under Client cases." : "No client cases yet."}
        </p>
      ) : (
        <div className="divide-y divide-line">
          {groups.map(({ priority, entries: items }) => (
            <div key={priority} role="group" aria-labelledby={`queue-${priority}`} className="px-5 py-4">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className={`size-2 rounded-full ${GROUP_TONES[priority]}`} />
                <h3 id={`queue-${priority}`} className="text-sm font-semibold">
                  {PRIORITY_GROUPS[priority].title} <span className="font-normal text-ink-faint">({items.length})</span>
                </h3>
              </div>
              <p className="mt-0.5 pl-4 text-xs text-ink-faint">{PRIORITY_GROUPS[priority].detail}</p>
              <ol className="mt-3 space-y-2">
                {items.map(({ case: c, reasons }) => {
                  const href = `/ca/cases/${encodeURIComponent(c.reference)}`;
                  return (
                    <li key={c.reference}
                        className="rounded-xl border border-line bg-paper px-4 py-3 transition-colors hover:border-ink-faint">
                      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                        <div className="min-w-0">
                          <p className="font-medium">
                            <Link href={href} className="hover:underline">{c.profile.full_name ?? c.client_first_name}</Link>
                          </p>
                          <p className="mt-0.5 font-mono text-xs text-ink-faint">
                            {c.reference} · FY {c.financial_year} · updated {c.updated_at.slice(0, 10)}
                          </p>
                        </div>
                        <Badge tone="neutral">{CASE_STATUS_LABELS[c.status] ?? c.status}</Badge>
                      </div>
                      {reasons.length > 0 && (
                        <ul aria-label="Why it is here" className="mt-2 flex flex-wrap gap-1.5">
                          {reasons.map((r) => (
                            <li key={r} className="rounded-md border border-line px-2 py-0.5 text-xs text-ink-soft">{r}</li>
                          ))}
                        </ul>
                      )}
                      <p className="mt-2 text-sm">
                        <span className="text-ink-faint">Next: </span>
                        <Link href={href} className="font-medium text-teal underline underline-offset-2">
                          {nextAction(c.status, c.readiness)}
                        </Link>
                      </p>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
