import Link from "next/link";
import type { CaseReview } from "@/lib/case-review";
import { RECONCILIATION_LABELS, UNVERIFIED_REASONS } from "@/lib/case-review";
import { caseTabHref } from "@/lib/case-tabs";
import { formatInr } from "@/lib/money";
import { describe } from "@/lib/statements";
import { ReviewTable } from "./ReviewTable";

const RECON_TONES: Record<string, string> = {
  passed: "border-teal/30 bg-teal-wash text-teal-deep",
  failed: "border-rose-ink/30 bg-rose-wash text-rose-ink",
  incomplete: "border-amber-ink/40 bg-amber-wash text-amber-ink",
  not_available: "border-amber-ink/40 bg-amber-wash text-amber-ink",
};
const RECON_WORD: Record<string, string> = { passed: "PASS", failed: "FAIL", incomplete: "UNABLE TO VERIFY",
  not_available: "UNABLE TO VERIFY" };

function NoReview({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-2xl border border-dashed border-line bg-surface px-5 py-10 text-center">
      <p className="font-medium">No review prepared yet.</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">{children}</p>
    </section>
  );
}

// The statement's validation (Overview tab): balance reconciliation and
// extraction. All values come from the API; nothing is recalculated here.
export function StatementValidation({ review }: { review: CaseReview | null }) {
  if (review === null) {
    return (
      <NoReview>Choose a statement under Uploaded statements and select Prepare review to read and classify its transactions.</NoReview>
    );
  }
  const { totals, reconciliation: rec } = review;
  return (
    <section aria-labelledby="validation" className="mt-8 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="validation" className="scroll-mt-32 font-serif text-2xl font-medium">Statement validation</h2>
        <p className="text-xs text-ink-faint">
          Prepared {review.prepared_at.slice(0, 16).replace("T", " ")} UTC from {review.statement.display_name}
          {review.period_start && ` · ${review.period_start} to ${review.period_end ?? "?"}`}
          {review.classifier_version && ` · rules ${review.classifier_version.replace(/^itr_intake\.classifier\//, "")}`}
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className={`rounded-2xl border p-5 ${RECON_TONES[rec.status] ?? RECON_TONES.not_available}`}>
          <p className="text-xs font-medium uppercase tracking-wide">Balance reconciliation</p>
          <p className="mt-1 font-serif text-3xl font-medium">{RECON_WORD[rec.status] ?? rec.status}</p>
          <p className="mt-1 text-sm">{RECONCILIATION_LABELS[rec.status] ?? rec.status}</p>
          {rec.status !== "not_available" && (
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums sm:grid-cols-4">
              <div><dt className="text-xs opacity-80">Opening</dt><dd>{formatInr(rec.opening_balance)}</dd></div>
              <div><dt className="text-xs opacity-80">Expected closing</dt><dd>{formatInr(rec.expected_closing)}</dd></div>
              <div><dt className="text-xs opacity-80">Stated closing</dt><dd>{formatInr(rec.stated_closing)}</dd></div>
              <div><dt className="text-xs opacity-80">Difference</dt><dd className="font-semibold">{formatInr(rec.difference)}</dd></div>
            </dl>
          )}
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">Extraction</p>
          <p className={`mt-1 font-serif text-2xl font-medium ${review.verified ? "text-teal-deep" : "text-amber-ink"}`}>
            {review.verified ? "Verified" : "Unverified"}
          </p>
          {review.verified ? (
            <p className="mt-1 text-sm text-ink-soft">Every row was read and the balances reconcile.</p>
          ) : (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-amber-ink">
              {review.unverified_reasons.map((r) => <li key={r}>{UNVERIFIED_REASONS[r] ?? describe(r)}</li>)}
            </ul>
          )}
          <dl className="mt-3 grid grid-cols-3 gap-2 text-sm tabular-nums">
            <div><dt className="text-xs text-ink-soft">Rows read</dt><dd className="font-medium">{totals.valid} / {totals.rows}</dd></div>
            <div><dt className="text-xs text-ink-soft">Credits</dt><dd className="font-medium">{formatInr(totals.credits)}</dd></div>
            <div><dt className="text-xs text-ink-soft">Debits</dt><dd className="font-medium">{formatInr(totals.debits)}</dd></div>
          </dl>
        </div>
      </div>
    </section>
  );
}

// The transaction review and its Needs Review queue (Transactions tab).
export function TransactionReview({ reference, review, caseClosed }: { reference: string; review: CaseReview | null;
  caseClosed: boolean }) {
  if (review === null) {
    return (
      <NoReview>
        Prepare a review from one of the client&rsquo;s statements on the{" "}
        <Link href={caseTabHref(reference, "overview")} className="font-medium text-teal underline">Overview</Link> tab first.
      </NoReview>
    );
  }
  const { totals } = review;
  return (
    <section aria-labelledby="review" className="mt-8 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="review" className="font-serif text-2xl font-medium">Transaction review</h2>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-soft">
          <div><dt className="inline">Auto-classified </dt><dd className="inline font-medium text-ink">{totals.auto}</dd></div>
          <div><dt className="inline">To confirm </dt><dd className="inline font-medium text-amber-ink">{totals.confirm}</dd></div>
          <div><dt className="inline">To classify </dt><dd className="inline font-medium text-rose-ink">{totals.manual}</dd></div>
          <div><dt className="inline">Reviewed by CA </dt><dd className="inline font-medium text-ink">{totals.reviewed}</dd></div>
          <div><dt className="inline">Not read </dt><dd className="inline font-medium text-ink">{totals.rejected}</dd></div>
        </dl>
      </div>
      {totals.stale_decisions > 0 && (
        <p className="rounded-lg border border-amber-ink/30 bg-amber-wash px-3 py-2 text-sm text-amber-ink" role="status">
          {totals.stale_decisions} earlier decision{totals.stale_decisions === 1 ? "" : "s"} no longer match{totals.stale_decisions === 1 ? "es" : ""} a
          row, because the statement now reads differently. {totals.stale_decisions === 1 ? "It was" : "They were"} kept but
          not applied; please review those rows again.
        </p>
      )}
      <p className="text-xs text-ink-faint">
        Categories describe what each transaction appears to be; they are not tax conclusions. Your decisions are saved
        with the case and survive preparing the review again; the extracted rows are never changed.
      </p>
      <ReviewTable reference={reference} review={review} caseClosed={caseClosed} />
    </section>
  );
}
