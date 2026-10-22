import type { CaseReview } from "@/lib/case-review";
import { formatInr } from "@/lib/money";
import { WorkbookDownload } from "./WorkbookDownload";

// 5. ITR summary and review flags, and 6. the workbook. Gross figures as
// classified (CA decisions included); flags are prompts for verification.
export function CaseItrSummary({ reference, review }: { reference: string; review: CaseReview | null }) {
  if (review === null) {
    return (
      <section aria-labelledby="itr" className="mt-8 rounded-2xl border border-line bg-white p-6">
        <h2 id="itr" className="font-serif text-xl font-medium">ITR summary and workbook</h2>
        <p className="mt-2 text-sm text-ink-soft">Available once a statement review is prepared.</p>
      </section>
    );
  }
  const used = review.itr.categories.filter((c) => c.count > 0);
  const nil = review.itr.categories.length - used.length;
  return (
    <section aria-labelledby="itr" className="mt-8 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="itr" className="font-serif text-2xl font-medium">ITR summary</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Gross amounts from this statement as classified, including your decisions. Not a tax computation.
          </p>
        </div>
        <WorkbookDownload reference={reference} available verified={review.verified} />
      </div>

      {review.itr.flags.length > 0 && (
        <div className="rounded-2xl border border-amber-ink/30 bg-amber-wash/60 p-5">
          <h3 className="text-sm font-semibold text-amber-ink">Points to verify ({review.itr.flags.length})</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {review.itr.flags.map((f) => (
              <li key={f.code}>
                <p className="font-medium">{f.title}</p>
                <p className="text-ink-soft">{f.detail}</p>
                {f.rows.length > 0 && (
                  <p className="text-xs text-ink-faint">Rows {f.rows.slice(0, 20).join(", ")}{f.rows.length > 20 ? " …" : ""}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-2xl border border-line bg-white">
          <h3 className="border-b border-line px-5 py-3 text-sm font-medium">Key figures for ITR</h3>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-line">
              {review.itr.key_figures.map((k) => (
                <tr key={k.label}>
                  <td className="px-5 py-2">{k.label}<span className="block text-xs text-ink-faint">{k.basis}</span></td>
                  <td className="whitespace-nowrap px-5 py-2 text-right tabular-nums">{formatInr(k.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="overflow-hidden rounded-2xl border border-line bg-white">
          <h3 className="border-b border-line px-5 py-3 text-sm font-medium">Totals by category</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="bg-paper text-xs uppercase tracking-wide text-ink-faint">
                <tr>
                  <th scope="col" className="px-4 py-2 text-left font-medium">Category</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Txns</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Debit</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {used.map((c) => (
                  <tr key={c.category}>
                    <td className="px-4 py-2">{c.category}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{c.count}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatInr(c.debit, { blankZero: true })}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">{formatInr(c.credit, { blankZero: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-xs text-ink-faint">{nil} other categories are nil (shown as 0 in the workbook).</p>
        </div>
      </div>
    </section>
  );
}
