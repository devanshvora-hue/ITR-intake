import type { CaseReview } from "@/lib/case-review";
import { PREPARABLE_STATUSES } from "@/lib/case-review";
import { describe, formatBytes, pagesByWarning, STATUS_LABELS, STATUS_TONES, type StatementUpload } from "@/lib/statements";
import { PrepareReviewButton } from "./PrepareReviewButton";

// The case's uploaded statements with their stored processing outcome and,
// for usable ones, the action that builds the case review. No file contents
// or download links: the API exposes results only.
export function CaseStatements({ reference, statements, review, caseClosed }: {
  reference: string;
  statements: StatementUpload[];
  review: CaseReview | null;
  caseClosed: boolean;
}) {
  return (
    <section aria-labelledby="statements" className="mt-8 overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h2 id="statements" className="font-serif text-lg font-medium">Uploaded statements</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Choose the statement to review. Preparing a review re-reads the stored file on this server and classifies its
          transactions; it replaces any earlier review for this case.
        </p>
      </div>
      {statements.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-ink-soft">The client has not uploaded a statement yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {statements.map((s) => {
            const current = review?.statement.id === s.id;
            return (
              <li key={s.id} className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto]">
                <div className="min-w-0 space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all font-medium">{s.display_name}</span>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_TONES[s.status]}`}>
                      {STATUS_LABELS[s.status]}
                    </span>
                    {current && (
                      <span className="rounded-full bg-paper-deep px-2.5 py-0.5 text-xs font-medium text-ink-soft">
                        Used for the current review
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-ink-faint">
                    {s.file_type.toUpperCase()} · {formatBytes(s.size_bytes)} · uploaded{" "}
                    {s.uploaded_at.slice(0, 16).replace("T", " ")} UTC
                    {s.pages_total !== null && ` · ${s.pages_total} pages`}
                  </p>
                  {s.status === "rejected" ? (
                    <p className="text-rose-ink">{describe(s.error_code ?? "")}</p>
                  ) : (
                    <p className="text-ink-soft">
                      {s.rows_extracted} read · {s.rows_rejected} rejected · {s.rows_duplicate} duplicate-looking
                      {s.period_start && s.period_end && ` · ${s.period_start} to ${s.period_end}`}
                    </p>
                  )}
                  {s.reasons.length > 0 && (
                    <ul className="list-disc pl-5 text-xs text-amber-ink">
                      {s.reasons.map((r) => <li key={r}>{describe(r)}</li>)}
                    </ul>
                  )}
                  {pagesByWarning(s.page_warnings).map((w) => <p key={w} className="text-xs text-ink-soft">{w}</p>)}
                </div>
                <div className="md:w-56">
                  {caseClosed ? (
                    <p className="text-xs text-ink-faint">The case is closed.</p>
                  ) : PREPARABLE_STATUSES.has(s.status) ? (
                    <PrepareReviewButton reference={reference} statementId={s.id} replacesReview={review !== null}
                                         isCurrent={current} />
                  ) : (
                    <p className="text-xs text-ink-faint">This statement cannot be reviewed.</p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
