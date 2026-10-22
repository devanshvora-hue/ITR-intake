"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";
import type { CaseReview, ReviewRow } from "@/lib/case-review";
import { formatInr } from "@/lib/money";
import { describe } from "@/lib/statements";

// The 28 categories of the specification, in its order.
export const CATEGORY_OPTIONS = [
  "Salary / Pension", "Business / Professional Receipts", "Rent Received", "Interest – Savings Bank",
  "Interest – FD / RD / Others", "Dividend", "Sale / Redemption of Investments", "Income Tax Refund",
  "Loans Received / Repayment of Loans Given", "Gifts / Receipts from Non-relatives", "Investments – Tax-saving",
  "Investments – Others", "Insurance – Health", "Loan EMI / Repayment", "Loans Given", "Tax Payments", "Donations",
  "Credit Card Payments", "Rent Paid", "Business / Professional Expenses", "Self Transfer", "Family Transfer",
  "Cash Withdrawal", "Cash Deposit", "Personal Expenses", "Bank Charges", "Reversals / Refunds", "Others – Needs Review",
];

type Filter = "all" | "needs" | "auto" | "reviewed" | "rejected";
const FILTERS: [Filter, string][] = [
  ["needs", "Needs review"], ["all", "All"], ["auto", "Auto-classified"], ["reviewed", "Reviewed by CA"], ["rejected", "Rejected"],
];

const GROUP_BADGES: Record<ReviewRow["group"], [string, string]> = {
  auto: ["Auto-classified", "bg-teal-wash text-teal-deep"],
  confirm: ["Confirm category", "bg-amber-wash text-amber-ink"],
  manual: ["Classify manually", "bg-rose-wash text-rose-ink"],
  reviewed: ["Reviewed by CA", "bg-paper-deep text-ink"],
  rejected: ["Not read", "bg-rose-wash text-rose-ink"],
};

const firstSentence = (text: string) => {
  const m = /^(.+?[.;])\s/.exec(text);
  return m ? m[1] : text;
};

function matches(row: ReviewRow, filter: Filter, query: string): boolean {
  if (filter === "needs" && row.group !== "confirm" && row.group !== "manual") return false;
  if (filter === "auto" && row.group !== "auto") return false;
  if (filter === "reviewed" && row.group !== "reviewed") return false;
  if (filter === "rejected" && row.group !== "rejected") return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return [row.narration, row.counterparty, row.category].some((v) => v?.toLowerCase().includes(q));
}

function RowEditor({ reference, row, onDone }: { reference: string; row: ReviewRow; onDone: () => void }) {
  const router = useRouter();
  const [category, setCategory] = useState(row.category ?? "Others – Needs Review");
  const [note, setNote] = useState(row.decision?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(value: string | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await postJson(`/api/ca/cases/${encodeURIComponent(reference)}/review/rows/${row.row_number}`,
      { category: value, ...(value && note.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (result.status === 401) {
      router.replace("/ca/login");
      return;
    }
    if (!result.ok) {
      setError(result.status === 0 ? "The server is not reachable. Try again."
        : String(result.data.message ?? "The change could not be saved."));
      return;
    }
    onDone();
    router.refresh();
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-line bg-paper p-3">
      <label className="block text-xs font-medium" htmlFor={`cat-${row.row_number}`}>Category</label>
      <select id={`cat-${row.row_number}`} value={category} onChange={(e) => setCategory(e.target.value)} disabled={busy}
              className="w-full rounded-lg border border-control bg-surface px-2 py-1.5 text-sm">
        {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <label className="block text-xs font-medium" htmlFor={`note-${row.row_number}`}>
        Note <span className="font-normal text-ink-faint">(optional, kept with the decision)</span>
      </label>
      <input id={`note-${row.row_number}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} disabled={busy}
             className="w-full rounded-lg border border-control bg-surface px-2 py-1.5 text-sm" />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => send(category)}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-60">
          {busy ? "Saving…" : category === row.classifier_category ? "Confirm category" : "Save category"}
        </button>
        {row.decision && (
          <button type="button" disabled={busy} onClick={() => send(null)}
                  className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium disabled:opacity-60">
            Undo my decision
          </button>
        )}
        <button type="button" disabled={busy} onClick={onDone}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-soft">Cancel</button>
      </div>
      {error && <FormMessage tone="error">{error}</FormMessage>}
    </div>
  );
}

// Filterable, searchable transaction table with per-row category decisions.
// Extraction validity (Not read), classification confidence and review status
// are shown separately.
export function ReviewTable({ reference, review, caseClosed }: { reference: string; review: CaseReview; caseClosed: boolean }) {
  const t = review.totals;
  const [filter, setFilter] = useState<Filter>(t.confirm + t.manual > 0 ? "needs" : "all");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const counts: Record<Filter, number> = { all: review.rows.length, needs: t.confirm + t.manual, auto: t.auto,
    reviewed: t.reviewed, rejected: t.rejected };
  const shown = useMemo(() => review.rows.filter((r) => matches(r, filter, query.trim())), [review.rows, filter, query]);

  const toggle = (row: number) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(row)) next.delete(row); else next.add(row);
    return next;
  });
  const reviewBadge = (r: ReviewRow) => {
    const [badge, tone] = GROUP_BADGES[r.group];
    return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{badge}</span>;
  };
  const rejectedText = (r: ReviewRow) => (
    <p className="text-rose-ink">
      Not read from the statement{r.source_page ? ` (page ${r.source_page})` : ""}: {r.issues.map(describe).join(", ")}
    </p>
  );
  const narrationCell = (r: ReviewRow) => {
    const meta = [r.mode === "Other" ? null : r.mode, r.counterparty].filter(Boolean).join(" · ");
    return (
      <>
        {r.narration}
        {meta && <span className="mt-0.5 block text-xs text-ink-faint">{meta}</span>}
      </>
    );
  };
  const categoryCell = (r: ReviewRow) => {
    const reason = r.classification_reason ?? "";
    const open = expanded.has(r.row_number);
    return (
      <div>
        <span className="font-medium">{r.category}</span>
        {r.decision?.decision === "changed" && (
          <span className="block text-xs text-ink-faint">Rules said: {r.classifier_category}</span>
        )}
        {r.stale_decision && (
          <span className="mt-1 block rounded bg-amber-wash px-2 py-1 text-xs text-amber-ink">
            Your earlier decision ({r.stale_decision.category}) no longer matches this row, because it now reads
            differently. It was not applied; decide again.
          </span>
        )}
        <span className="mt-0.5 block text-xs text-ink-soft">
          {r.decision ? (r.decision.note ? `CA note: ${r.decision.note}` : "Decided by CA") : open ? reason : firstSentence(reason)}
          {!r.decision && reason !== firstSentence(reason) && (
            <button type="button" className="ml-1 text-teal underline" onClick={() => toggle(r.row_number)}>
              {open ? "less" : "more"}
            </button>
          )}
        </span>
        {editing === r.row_number && <RowEditor reference={reference} row={r} onDone={() => setEditing(null)} />}
      </div>
    );
  };
  const reviewActions = (r: ReviewRow) => (
    <>
      {r.confidence && !r.decision && <span className="mt-1 block text-xs text-ink-faint">{r.confidence} confidence</span>}
      {!caseClosed && editing !== r.row_number && (
        <button type="button" onClick={() => setEditing(r.row_number)} className="mt-1.5 block text-xs font-medium text-teal underline">
          {r.group === "confirm" ? "Confirm or change" : r.group === "manual" ? "Choose category" : "Change"}
        </button>
      )}
    </>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter transactions" className="flex flex-wrap gap-1.5">
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === key
                      ? "border-accent bg-accent text-on-accent" : "border-line bg-surface text-ink-soft hover:border-ink-faint"}`}>
              {label} <span className="tabular-nums opacity-80">{counts[key]}</span>
            </button>
          ))}
        </div>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search narration or payee"
               aria-label="Search narration or payee"
               className="w-full rounded-lg border border-control bg-surface px-3 py-1.5 text-sm sm:w-64" />
      </div>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        {shown.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-ink-soft">
            {filter === "needs" && !query ? "Nothing needs review. Every transaction has a category." : "No transactions match."}
          </p>
        ) : (
          <>
            {/* Phones and narrow tablets: one card per transaction, decision controls always in view. */}
            <ul className="divide-y divide-line md:hidden">
              {shown.map((r) => (
                <li key={r.row_number} className={`space-y-2 px-4 py-3 text-sm ${r.group === "rejected" ? "bg-rose-wash/30" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs text-ink-faint">
                      #{r.row_number}{r.source_page ? ` · p.${r.source_page}` : ""} · {r.date ?? "date not read"}
                    </p>
                    {reviewBadge(r)}
                  </div>
                  {r.group === "rejected" ? rejectedText(r) : (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 break-words">{narrationCell(r)}</div>
                        <div className="shrink-0 text-right tabular-nums">
                          {Number(r.debit ?? 0) > 0 && <p>−{formatInr(r.debit)}</p>}
                          {Number(r.credit ?? 0) > 0 && <p className="text-teal-deep">+{formatInr(r.credit)}</p>}
                          <p className="text-xs text-ink-faint">Bal. {formatInr(r.balance)}</p>
                        </div>
                      </div>
                      {categoryCell(r)}
                      {reviewActions(r)}
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-paper text-xs uppercase tracking-wide text-ink-faint">
                  <tr>
                    <th scope="col" className="px-3 py-3 font-medium">#</th>
                    <th scope="col" className="px-3 py-3 font-medium">Date</th>
                    <th scope="col" className="px-3 py-3 font-medium">Narration</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">Debit</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">Credit</th>
                    <th scope="col" className="px-3 py-3 text-right font-medium">Balance</th>
                    <th scope="col" className="px-3 py-3 font-medium">Category</th>
                    <th scope="col" className="px-3 py-3 font-medium">Review</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line align-top">
                  {shown.map((r) => r.group === "rejected" ? (
                    <tr key={r.row_number} className="bg-rose-wash/30">
                      <td className="px-3 py-2.5 tabular-nums text-ink-faint">{r.row_number}</td>
                      <td colSpan={6} className="px-3 py-2.5">{rejectedText(r)}</td>
                      <td className="px-3 py-2.5">{reviewBadge(r)}</td>
                    </tr>
                  ) : (
                    <tr key={r.row_number}>
                      <td className="px-3 py-2.5 tabular-nums text-ink-faint">
                        {r.row_number}
                        {r.source_page && <span className="block text-[11px]">p.{r.source_page}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">{r.date}</td>
                      <td className="max-w-sm break-words px-3 py-2.5">{narrationCell(r)}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatInr(r.debit, { blankZero: true })}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{formatInr(r.credit, { blankZero: true })}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-ink-soft">{formatInr(r.balance)}</td>
                      <td className="min-w-56 px-3 py-2.5">{categoryCell(r)}</td>
                      <td className="px-3 py-2.5">{reviewBadge(r)}{reviewActions(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
