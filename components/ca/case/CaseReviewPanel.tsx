import type { CaseReview } from "@/lib/case-review";
import { RECONCILIATION_LABELS, UNVERIFIED_REASONS } from "@/lib/case-review";
import { describe } from "@/lib/statements";
import { WorkbookDownload } from "./WorkbookDownload";

function amount(value: string | null): string {
  return value === null || Number(value) === 0 ? "—" : value;
}

// The stored review: verification banner, totals, balance check and the
// classified rows. All values come from the API as text; nothing is
// recalculated or filled in here.
export function CaseReviewPanel({ reference, review }: { reference: string; review: CaseReview | null }) {
  if (review === null) {
    return (
      <section className="mt-8 rounded-2xl border border-dashed border-line bg-white px-5 py-10 text-center">
        <p className="font-medium">No review prepared yet.</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
          Choose a statement above and select Prepare review to classify its transactions.
        </p>
        <div className="mt-4 flex justify-center">
          <WorkbookDownload reference={reference} available={false} verified={false} />
        </div>
      </section>
    );
  }
  const { totals, reconciliation: rec } = review;
  const invalidRows = review.rows.filter((r) => !r.is_valid);
  return (
    <section aria-labelledby="review" className="mt-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="review" className="font-serif text-2xl font-medium">Transaction review</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Prepared {review.prepared_at.slice(0, 16).replace("T", " ")} UTC from {review.statement.display_name}
            {review.classifier_version && ` · ${review.classifier_version}`}
          </p>
        </div>
        <WorkbookDownload reference={reference} available verified={review.verified} />
      </div>

      {review.verified ? (
        <div className="rounded-xl border border-teal/30 bg-teal-wash px-4 py-3 text-sm text-teal-deep" role="status">
          <p className="font-semibold">Verified extraction</p>
          <p className="mt-1">
            Every row was read, and the running balance reconciles. Classification is still an aid: check the rows marked
            for review.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-ink/40 bg-amber-wash px-4 py-3 text-sm text-amber-ink" role="alert">
          <p className="font-semibold">Unverified: do not rely on these figures without checking the statement</p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {review.unverified_reasons.map((r) => <li key={r}>{UNVERIFIED_REASONS[r] ?? describe(r)}</li>)}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Rows", value: `${totals.valid} valid / ${totals.rows}` },
          { label: "Needs review", value: String(totals.needs_review) },
          { label: "Credits (valid rows)", value: totals.credits },
          { label: "Debits (valid rows)", value: totals.debits },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-line bg-white p-4">
            <p className="text-xs text-ink-soft">{s.label}</p>
            <p className="mt-1 font-serif text-xl font-medium tabular-nums">{s.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-line bg-white p-4 text-sm">
        <p className="font-medium">Balance check: {RECONCILIATION_LABELS[rec.status] ?? rec.status}</p>
        {rec.status !== "not_available" && (
          <p className="mt-1 tabular-nums text-ink-soft">
            Opening {rec.opening_balance} · expected closing {rec.expected_closing} · stated closing {rec.stated_closing}
            {" "}· difference {rec.difference}
          </p>
        )}
        {(review.period_start || review.period_end) && (
          <p className="mt-1 text-ink-soft">Period {review.period_start ?? "?"} to {review.period_end ?? "?"}</p>
        )}
      </div>

      {invalidRows.length > 0 && (
        <div className="rounded-xl border border-rose-ink/20 bg-rose-wash px-4 py-3 text-sm text-rose-ink">
          <p className="font-medium">Rows not included ({invalidRows.length})</p>
          <p className="mt-1 text-xs">
            {invalidRows.slice(0, 40).map((r) => `Row ${r.row_number}: ${r.issues.map(describe).join(", ")}`).join("; ")}
            {invalidRows.length > 40 && ` and ${invalidRows.length - 40} more`}
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-line bg-white">
        {review.rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-soft">The statement produced no rows.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="bg-paper text-xs uppercase tracking-wide text-ink-faint">
                <tr>
                  {["#", "Date", "Description", "Debit", "Credit", "Balance", "Category", "Confidence", "Review"].map(
                    (h) => <th key={h} scope="col" className="px-3 py-3 font-medium">{h}</th>,
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {review.rows.map((r) =>
                  r.is_valid ? (
                    <tr key={r.row_number}>
                      <td className="px-3 py-2.5 tabular-nums text-ink-faint">{r.row_number}</td>
                      <td className="whitespace-nowrap px-3 py-2.5">{r.date}</td>
                      <td className="max-w-xs break-words px-3 py-2.5">
                        {r.narration}
                        {r.classification_reason && (
                          <span className="mt-0.5 block text-xs text-ink-faint">{r.classification_reason}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{amount(r.debit)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{amount(r.credit)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{r.balance ?? "—"}</td>
                      <td className="px-3 py-2.5">{r.category}</td>
                      <td className="px-3 py-2.5 text-ink-soft">{r.confidence}</td>
                      <td className={`px-3 py-2.5 ${r.review_status === "Auto-classified" ? "text-ink-soft" : "font-medium text-amber-ink"}`}>
                        {r.review_status}
                      </td>
                    </tr>
                  ) : (
                    <tr key={r.row_number} className="bg-rose-wash/40">
                      <td className="px-3 py-2.5 tabular-nums text-ink-faint">{r.row_number}</td>
                      <td colSpan={8} className="px-3 py-2.5 text-rose-ink">
                        Not read: {r.issues.map(describe).join(", ")}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
