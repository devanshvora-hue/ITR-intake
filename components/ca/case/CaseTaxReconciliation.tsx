"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FormMessage, primaryButton } from "@/components/ca/Field";
import { postJson, uploadFile } from "@/lib/api-client";
import { formatInr } from "@/lib/money";
import {
  MATCH_LABELS, RECORD_CATEGORY_LABELS, REPORT_KIND_LABELS, REPORT_KINDS, WARNING_LABELS,
  type TaxReconciliationView, type TaxReconRecord,
} from "@/lib/tax-reconciliation";

const base = (reference: string) => `/api/ca/cases/${encodeURIComponent(reference)}/tax-reports`;
const smallButton = "rounded-lg border border-line bg-white px-2.5 py-1 text-xs font-medium hover:border-ink-faint disabled:opacity-60";

function Uploader({ reference, caseClosed }: { reference: string; caseClosed: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("ais");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const file = input.current?.files?.[0];
    if (!file) {
      setMessage({ tone: "error", text: "Choose a CSV or Excel (.xlsx) file first." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const result = await uploadFile(`${base(reference)}?kind=${encodeURIComponent(kind)}`, file);
    setBusy(false);
    if (input.current) input.current.value = "";
    if (result.status === 401) {
      router.replace("/ca/login");
      return;
    }
    if (result.ok) {
      const report = result.data.report as { records: number; warnings: number };
      setMessage({ tone: "info", text: `Read ${report.records} entr${report.records === 1 ? "y" : "ies"}`
        + `${report.warnings ? `; ${report.warnings} row${report.warnings === 1 ? "" : "s"} could not be read (listed below)` : ""}.` });
      router.refresh();
      return;
    }
    setMessage({ tone: "error", text: result.status === 0 ? "The server is not reachable. Try again."
      : result.status === 413 ? "The file is larger than 4 MB." : String(result.data.message ?? "The file could not be uploaded.") });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-xl border border-line p-4">
      <h3 className="text-sm font-medium">Upload a report</h3>
      <div className="flex flex-wrap gap-3">
        <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={caseClosed || busy} aria-label="Report type"
                className="rounded-lg border border-line bg-white px-2 py-1.5 text-sm">
          {REPORT_KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <input ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
               disabled={caseClosed || busy} aria-label="Report file"
               className="min-w-0 flex-1 text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-sm" />
      </div>
      <p className="text-xs text-ink-faint">
        CSV or Excel (.xlsx) up to 4 MB, with a header row that has an amount column and a description, category or section
        column. PDF and JSON reports are not read in this version.
      </p>
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      <button type="submit" disabled={caseClosed || busy} className={primaryButton}>{busy ? "Reading…" : "Upload and reconcile"}</button>
    </form>
  );
}

function RecordReview({ reference, record, caseClosed }: { reference: string; record: TaxReconRecord; caseClosed: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState(record.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(status: "confirmed" | "unresolved" | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await postJson(`${base(reference)}/records/${encodeURIComponent(record.id)}`,
      { status, ...(status && note.trim() ? { note: note.trim() } : {}), ...(status ? { signature: record.signature } : {}) });
    setBusy(false);
    if (result.status === 401) {
      router.replace("/ca/login");
      return;
    }
    if (!result.ok) {
      setError(result.status === 0 ? "The server is not reachable." : String(result.data.message ?? "Not saved."));
      return;
    }
    router.refresh();
  }
  if (caseClosed) return null;
  return (
    <div className="mt-2 space-y-1.5">
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Note (optional)" disabled={busy}
             aria-label="Note" className="w-full rounded-lg border border-line bg-white px-2 py-1 text-xs" />
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={smallButton} disabled={busy} onClick={() => send("confirmed")}>Confirm</button>
        <button type="button" className={smallButton} disabled={busy} onClick={() => send("unresolved")}>Mark unresolved</button>
        {(record.review === "confirmed" || record.review === "unresolved") && (
          <button type="button" className={smallButton} disabled={busy} onClick={() => send(null)}>Clear</button>
        )}
      </div>
      {error && <p className="text-xs text-rose-ink" role="alert">{error}</p>}
    </div>
  );
}

function Withdraw({ reference, reportId }: { reference: string; reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className={smallButton} disabled={busy} onClick={async () => {
      if (!window.confirm("Take this report out of the reconciliation? The file stays on record.")) return;
      setBusy(true);
      const result = await postJson(`${base(reference)}/${encodeURIComponent(reportId)}/withdraw`);
      setBusy(false);
      if (result.ok) router.refresh();
    }}>{busy ? "Removing…" : "Remove"}</button>
  );
}

const REVIEW_LABELS: Record<string, [string, string]> = {
  auto: ["No action needed", "text-teal-deep"], open: ["To review", "font-medium text-amber-ink"],
  confirmed: ["Confirmed by CA", "text-teal-deep"], unresolved: ["Unresolved", "font-medium text-rose-ink"],
};

// AIS / TIS / Form 26AS reconciliation: upload, per-entry matches against the
// reviewed bank statement, and the CA's verdicts. Assistance only.
export function CaseTaxReconciliation({ reference, view, caseClosed }: { reference: string; view: TaxReconciliationView;
  caseClosed: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const records = showAll ? view.records : view.records.filter((r) => r.review !== "auto");
  return (
    <section aria-labelledby="tax-recon" className="mt-8 rounded-2xl border border-line bg-white p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="tax-recon" className="font-serif text-xl font-medium">AIS / TIS / Form 26AS reconciliation</h2>
        {view.status !== "no_reports" && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${view.status === "complete"
            ? "bg-teal-wash text-teal-deep" : "bg-amber-wash text-amber-ink"}`}>
            {view.status === "complete" ? "All entries matched or confirmed" : `${view.open_count} to resolve`}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Matching assistance between the reports and the reviewed bank statement. It does not decide tax treatment, and an
        entry need not appear in this account (income may arrive elsewhere): confirm or mark each difference.
      </p>
      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {view.status === "no_reports" ? (
            <p className="text-sm text-ink-soft">No reports uploaded yet.</p>
          ) : (
            <>
              {!view.review_prepared && (
                <FormMessage tone="error">Prepare the statement review first: entries cannot be compared until then.</FormMessage>
              )}
              <ul className="space-y-2 text-sm">
                {view.reports.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-paper px-3 py-2">
                    <span>
                      <span className="font-medium">{REPORT_KIND_LABELS[r.kind] ?? r.kind}</span> · {r.display_name} ·{" "}
                      {r.records_count} entr{r.records_count === 1 ? "y" : "ies"}
                      {r.warnings.length > 0 && (
                        <span className="block text-xs text-amber-ink">
                          Not read: {r.warnings.slice(0, 10).map((w) => `row ${w.row} (${WARNING_LABELS[w.code] ?? w.code})`).join(", ")}
                          {r.warnings.length > 10 ? " …" : ""}
                        </span>
                      )}
                    </span>
                    <span className="flex gap-2">
                      <a className={smallButton} href={`${base(reference)}/${encodeURIComponent(r.id)}/file`}>Original</a>
                      {!caseClosed && <Withdraw reference={reference} reportId={r.id} />}
                    </span>
                  </li>
                ))}
              </ul>

              {view.summary.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead className="bg-paper text-xs uppercase tracking-wide text-ink-faint">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium" scope="col">Item</th>
                        <th className="px-3 py-2 text-right font-medium" scope="col">As per reports</th>
                        <th className="px-3 py-2 text-right font-medium" scope="col">As per bank</th>
                        <th className="px-3 py-2 text-right font-medium" scope="col">Difference</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {view.summary.map((s) => (
                        <tr key={s.category}>
                          <td className="px-3 py-2">{RECORD_CATEGORY_LABELS[s.category] ?? s.category}
                            <span className="block text-xs text-ink-faint">TDS per reports {formatInr(s.taxDeducted)}</span></td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatInr(s.reported)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatInr(s.bank)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatInr(s.difference)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{showAll ? "All entries" : "Entries to review"} ({records.length})</h3>
                <button type="button" className="text-xs font-medium text-teal underline" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Show only entries to review" : `Show all ${view.records.length}`}
                </button>
              </div>
              {records.length === 0 ? (
                <p className="text-sm text-ink-soft">Nothing to review: every entry is matched, counted once or confirmed.</p>
              ) : (
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {records.map((r) => {
                    const [label, tone] = MATCH_LABELS[r.status] ?? [r.status, ""];
                    const [reviewLabel, reviewTone] = REVIEW_LABELS[r.review];
                    return (
                      <li key={r.id} className="space-y-1 px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <p className="min-w-0 break-words">
                            <span className="font-medium">{r.description}</span>
                            <span className="block text-xs text-ink-faint">
                              {REPORT_KIND_LABELS[r.report_kind] ?? r.report_kind} row {r.source_row}
                              {r.party ? ` · ${r.party}` : ""} · {r.date ?? "no date (annual total)"}
                            </span>
                          </p>
                          <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
                        </div>
                        <p className="tabular-nums text-ink-soft">
                          Reported {formatInr(r.amount)}{r.tax_deducted ? ` (TDS ${formatInr(r.tax_deducted)})` : ""}
                          {r.bank_amount !== null && <> · bank {formatInr(r.bank_amount)}{r.bank_rows.length ? ` (row ${r.bank_rows.join(", ")})` : ""}</>}
                          {r.difference !== null && r.difference !== "0.00" && <> · difference <span className="font-medium">{formatInr(r.difference)}</span></>}
                        </p>
                        <p className={`text-xs ${reviewTone}`}>
                          {reviewLabel}{r.note ? ` — ${r.note}` : ""}
                          {r.stale_review && " (an earlier verdict no longer applies: the match changed)"}
                        </p>
                        {r.review !== "auto" || showAll ? <RecordReview reference={reference} record={r} caseClosed={caseClosed} /> : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              {view.bank_only.length > 0 && (
                <div className="rounded-xl border border-amber-ink/30 bg-amber-wash/60 p-4 text-sm">
                  <p className="font-medium text-amber-ink">Income credits in the bank statement that no report shows ({view.bank_only.length})</p>
                  <ul className="mt-1 space-y-0.5 text-ink-soft">
                    {view.bank_only.slice(0, 20).map((b) => (
                      <li key={b.row_number}>Row {b.row_number} · {b.date} · {b.category} · {formatInr(b.amount)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
        <Uploader reference={reference} caseClosed={caseClosed} />
      </div>
    </section>
  );
}
