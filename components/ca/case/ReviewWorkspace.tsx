"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { CaseReview, ReviewRow } from "@/lib/case-review";
import { formatInr } from "@/lib/money";
import {
  CATEGORY_OPTIONS, defaultFilter, FILTERS, filterCounts, GROUP_LABELS, isDecidable, isDirty, moveSelection,
  saveDecision, savedValues, selectionAfterSave, visibleRows, type Draft, type Filter,
} from "@/lib/review-workspace";
import { describe } from "@/lib/statements";
import type { Tone } from "@/lib/tones";

const GROUP_TONES: Record<ReviewRow["group"], Tone> = {
  auto: "success",
  confirm: "warning",
  manual: "danger",
  reviewed: "neutral",
  rejected: "danger",
};

const optionId = (row: number) => `txn-${row}`;

function withoutDraft(all: Record<number, Draft>, row: number): Record<number, Draft> {
  const rest = { ...all };
  delete rest[row];
  return rest;
}

/** Wide screens show the list and the detail side by side (Tailwind's lg). */
const isWide = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;

function Amount({ row }: { row: ReviewRow }) {
  return (
    <span className="shrink-0 text-right tabular-nums">
      {Number(row.debit ?? 0) > 0 && <span className="block">−{formatInr(row.debit)}</span>}
      {Number(row.credit ?? 0) > 0 && <span className="block text-teal-deep">+{formatInr(row.credit)}</span>}
    </span>
  );
}

function rejectedText(row: ReviewRow) {
  return `Not read from the statement${row.source_page ? ` (page ${row.source_page})` : ""}: ${row.issues.map(describe).join(", ")}`;
}

function ListRow({ row, selected, dirty, onChoose }: { row: ReviewRow; selected: boolean; dirty: boolean; onChoose: () => void }) {
  return (
    <li id={optionId(row.row_number)} role="option" aria-selected={selected} onClick={onChoose}
        className={`cursor-pointer border-l-2 px-4 py-2 text-sm transition-colors ${selected
          ? "border-accent bg-accent-bg" : "border-transparent hover:bg-paper-deep"}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 line-clamp-2 break-words lg:line-clamp-1">
          {row.group === "rejected" ? rejectedText(row) : row.narration}
        </p>
        {row.group !== "rejected" && <Amount row={row} />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs text-ink-faint">
          #{row.row_number}{row.source_page ? ` · p.${row.source_page}` : ""} · {row.date ?? "date not read"}
        </span>
        <Badge tone={GROUP_TONES[row.group]}>{GROUP_LABELS[row.group]}</Badge>
        {row.group !== "rejected" && <span className="min-w-0 truncate text-xs text-ink-soft">{row.category}</span>}
        {row.stale_decision && <span className="text-xs font-medium text-warning-fg">Earlier decision not applied</span>}
        {dirty && <span className="text-xs font-medium text-warning-fg">Unsaved changes</span>}
      </div>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

/** The selected transaction's facts and, when it can take one, its category decision. */
export function TransactionDetail({ row, inList, draft, dirty, busy, caseClosed, headingRef, onEdit, onSave, onUndo, onDiscard,
  onShowAll }: {
  row: ReviewRow | null;
  /** False when the current filter or search hides the selected row. */
  inList: boolean;
  draft: Draft | null;
  dirty: boolean;
  busy: boolean;
  caseClosed: boolean;
  headingRef?: React.Ref<HTMLHeadingElement>;
  onEdit: (change: Partial<Draft>) => void;
  onSave: (category: string) => void;
  onUndo: () => void;
  onDiscard: () => void;
  onShowAll: () => void;
}) {
  return (
    <>
      {!row ? (
        <>
          <h3 id="txn-detail" ref={headingRef} tabIndex={-1} className="text-base font-semibold">Transaction</h3>
          <p className="mt-2 text-sm text-ink-soft">Select a transaction to see its details and decide its category.</p>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 id="txn-detail" ref={headingRef} tabIndex={-1} className="text-base font-semibold">
              Transaction #{row.row_number}
            </h3>
            <Badge tone={GROUP_TONES[row.group]} size="md">{GROUP_LABELS[row.group]}</Badge>
          </div>
          {!inList && (
            <p className="mt-3 rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink-soft">
              Not in the list for the current filter or search.{" "}
              <button type="button" onClick={onShowAll} className="font-medium text-teal underline">Show all transactions</button>
            </p>
          )}

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Fact label="Date">{row.date ?? "Not read"}</Fact>
            <Fact label="Source">{row.source_page ? `Page ${row.source_page}` : "CSV row"}</Fact>
            <div className="col-span-2"><Fact label="Narration">{row.narration ?? "—"}</Fact></div>
            {row.mode && row.mode !== "Other" && <Fact label="Mode">{row.mode}</Fact>}
            {row.counterparty && <Fact label="Counterparty">{row.counterparty}</Fact>}
            {row.group !== "rejected" && (
              <>
                <Fact label="Debit">{formatInr(row.debit, { blankZero: true })}</Fact>
                <Fact label="Credit">{formatInr(row.credit, { blankZero: true })}</Fact>
                <Fact label="Balance">{formatInr(row.balance)}</Fact>
              </>
            )}
          </dl>

          {row.group === "rejected" ? (
            <p className="mt-4 text-sm text-rose-ink">{rejectedText(row)}</p>
          ) : (
            <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
              <p><span className="text-ink-faint">Category: </span><span className="font-medium">{row.category}</span></p>
              {row.decision?.decision === "changed" && <p className="text-xs text-ink-faint">Rules said: {row.classifier_category}</p>}
              {row.decision
                ? <p className="text-xs text-ink-soft">{row.decision.note ? `CA note: ${row.decision.note}` : "Decided by CA"}</p>
                : row.confidence && <p className="text-xs text-ink-faint">{row.confidence} confidence</p>}
              {row.classification_reason && (
                <p className="text-xs text-ink-soft"><span className="text-ink-faint">Why: </span>{row.classification_reason}</p>
              )}
              {row.stale_decision && (
                <p className="rounded bg-amber-wash px-2 py-1 text-xs text-amber-ink">
                  Your earlier decision ({row.stale_decision.category}) no longer matches this row, because it now reads
                  differently. It was not applied; decide again.
                </p>
              )}
            </div>
          )}

          {isDecidable(row) && !caseClosed && draft && (
            <div className="mt-4 space-y-2 border-t border-line pt-4" aria-busy={busy || undefined}>
              <label className="block text-xs font-medium" htmlFor="txn-category">Category</label>
              <select id="txn-category" value={draft.category} onChange={(e) => onEdit({ category: e.target.value })}
                      disabled={busy} className="w-full rounded-lg border border-control bg-surface px-2 py-1.5 text-sm">
                {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <label className="block text-xs font-medium" htmlFor="txn-note">
                Note <span className="font-normal text-ink-faint">(optional, kept with the decision)</span>
              </label>
              <input id="txn-note" value={draft.note} onChange={(e) => onEdit({ note: e.target.value })} maxLength={300}
                     disabled={busy} className="w-full rounded-lg border border-control bg-surface px-2 py-1.5 text-sm" />
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" size="sm" loading={busy} onClick={() => onSave(draft.category)}>
                  {busy ? "Saving…" : draft.category === row.classifier_category ? "Confirm category" : "Save category"}
                </Button>
                {row.decision && (
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onUndo}>
                    Undo my decision
                  </Button>
                )}
                {dirty && (
                  <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={onDiscard}>
                    Discard changes
                  </Button>
                )}
              </div>
              {dirty && <p className="text-xs text-warning-fg">Unsaved changes. They stay here if you look at other transactions.</p>}
            </div>
          )}
          {isDecidable(row) && caseClosed && (
            <p className="mt-4 text-xs text-ink-faint">The case is closed; categories can no longer be changed.</p>
          )}
        </>
      )}
    </>
  );
}

// The review queue as a workspace: a dense, keyboard-navigable list beside a
// detail panel with the category decision for the selected transaction. All
// facts come from the review; decisions use the same request and messages as
// before. Below lg the list comes first and a chosen row opens as a stacked
// view with a way back.
export function ReviewWorkspace({ reference, review, caseClosed }: { reference: string; review: CaseReview; caseClosed: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>(() => defaultFilter(review));
  const [query, setQuery] = useState("");
  const shown = useMemo(() => visibleRows(review.rows, filter, query), [review.rows, filter, query]);
  const [selected, setSelected] = useState<number | null>(() => visibleRows(review.rows, defaultFilter(review), "")[0]?.row_number ?? null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const followKeyboard = useRef(false);
  // Set synchronously, so a double click cannot send a second request before `busy` re-renders.
  const inFlight = useRef(false);
  const counts = filterCounts(review);
  const row = review.rows.find((r) => r.row_number === selected) ?? null;
  const inList = row !== null && shown.some((r) => r.row_number === row.row_number);

  // Keep the keyboard-selected row in view inside the scrolling list.
  useEffect(() => {
    if (!followKeyboard.current || selected === null) return;
    followKeyboard.current = false;
    document.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function choose(rowNumber: number, open: boolean) {
    setSelected(rowNumber);
    setMessage(null);
    if (open && !isWide()) {
      setDetailOpen(true);
      requestAnimationFrame(() => heading.current?.focus());
    }
  }

  function backToList() {
    setDetailOpen(false);
    requestAnimationFrame(() => {
      const list = document.getElementById("txn-list");
      list?.focus();
      if (selected !== null) document.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest" });
    });
  }

  function onListKey(event: React.KeyboardEvent<HTMLUListElement>) {
    if ((event.key === "Enter" || event.key === " ") && selected !== null) {
      event.preventDefault();
      if (isWide()) heading.current?.focus();
      else choose(selected, true);
      return;
    }
    const next = moveSelection(shown, selected, event.key);
    if (next === undefined) return;
    event.preventDefault();
    followKeyboard.current = true;
    setSelected(next);
    setMessage(null);
  }

  function showInList() {
    setFilter("all");
    setQuery("");
  }

  const draft = row ? drafts[row.row_number] ?? savedValues(row) : null;
  const dirty = row ? isDirty(row, drafts[row.row_number]) : false;

  function edit(change: Partial<Draft>) {
    if (!row || !draft) return;
    setDrafts((all) => ({ ...all, [row.row_number]: { ...draft, ...change } }));
  }

  function discard() {
    if (!row) return;
    setDrafts((all) => withoutDraft(all, row.row_number));
  }

  async function send(category: string | null) {
    if (inFlight.current || !row || !draft) return; // one request at a time
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    const at = row.row_number;
    const next = category === null ? at : selectionAfterSave(shown, at);
    const outcome = await saveDecision(reference, at, category, draft.note);
    inFlight.current = false;
    setBusy(false);
    if (outcome.kind === "signed_out") {
      router.replace("/ca/login");
      return;
    }
    if (outcome.kind === "error") {
      setMessage({ tone: "error", text: outcome.message });
      return;
    }
    setDrafts((all) => withoutDraft(all, at));
    setSelected(next);
    setMessage({ tone: "info", text: category === null ? `Your decision on #${at} was undone.`
      : next === at ? `Saved #${at}.` : `Saved #${at}. Showing the next transaction.` });
    router.refresh();
  }

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
               aria-label="Search narration or payee" aria-controls="txn-list"
               className="w-full rounded-lg border border-control bg-surface px-3 py-1.5 text-sm sm:w-64" />
      </div>

      <p className="sr-only" role="status">{shown.length} transaction{shown.length === 1 ? "" : "s"} shown</p>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-4">
        <div className={`${detailOpen ? "hidden" : "block"} overflow-hidden rounded-2xl border border-line bg-surface lg:block`}>
          {shown.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-ink-soft">
              {filter === "needs" && !query ? "Nothing needs review. Every transaction has a category." : "No transactions match."}
            </p>
          ) : (
            <ul id="txn-list" role="listbox" aria-label="Transactions" tabIndex={0} onKeyDown={onListKey}
                aria-activedescendant={inList && row ? optionId(row.row_number) : undefined}
                className="divide-y divide-line lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto">
              {shown.map((r) => (
                <ListRow key={r.row_number} row={r} selected={r.row_number === selected}
                         dirty={isDirty(r, drafts[r.row_number])} onChoose={() => choose(r.row_number, true)} />
              ))}
            </ul>
          )}
        </div>

        <section aria-labelledby="txn-detail"
                 className={`${detailOpen ? "block" : "hidden"} rounded-2xl border border-line bg-surface p-5 lg:sticky lg:top-32 lg:block lg:max-h-[calc(100vh-9rem)] lg:overflow-y-auto`}>
          <button type="button" onClick={backToList} className="mb-3 text-sm font-medium text-teal underline lg:hidden">
            ← Back to list
          </button>
          {message && <div className="mb-3"><FormMessage tone={message.tone}>{message.text}</FormMessage></div>}
          <TransactionDetail row={row} inList={inList} draft={draft} dirty={dirty} busy={busy} caseClosed={caseClosed}
                             headingRef={heading} onEdit={edit} onSave={(category) => send(category)} onUndo={() => send(null)}
                             onDiscard={discard} onShowAll={showInList} />
        </section>
      </div>
    </div>
  );
}
