import { describe, formatBytes, pagesByWarning, STATUS_LABELS, STATUS_TONES, type StatementUpload } from "@/lib/statements";

// Shows the actual stored result of each upload: counts, reasons and the
// affected pages. Row numbers only; transaction contents are never shown.
export function StatementList({ statements }: { statements: StatementUpload[] }) {
  if (statements.length === 0) {
    return <p className="text-sm text-ink-soft">No statements uploaded yet.</p>;
  }
  return (
    <ul className="space-y-3">
      {statements.map((s) => (
        <li key={s.id} className="rounded-xl border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium break-all">{s.display_name}</p>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_TONES[s.status]}`}>
              {STATUS_LABELS[s.status]}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            {s.file_type.toUpperCase()} · {formatBytes(s.size_bytes)} · uploaded {s.uploaded_at.slice(0, 16).replace("T", " ")} UTC
            {s.pages_total !== null && ` · ${s.pages_total} page${s.pages_total === 1 ? "" : "s"}`}
          </p>
          {s.status === "rejected" ? (
            <p className="mt-2 text-sm text-rose-ink">{describe(s.error_code ?? "")}</p>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">
              {s.rows_extracted} transaction{s.rows_extracted === 1 ? "" : "s"} read
              {s.rows_rejected > 0 && ` · ${s.rows_rejected} row${s.rows_rejected === 1 ? "" : "s"} rejected`}
              {s.rows_duplicate > 0 && ` · ${s.rows_duplicate} duplicate-looking`}
              {s.period_start && s.period_end && ` · ${s.period_start} to ${s.period_end}`}
            </p>
          )}
          {s.status === "processing_failed" && (
            <p className="mt-2 text-sm text-rose-ink">It could not be processed. Your CA can see this upload.</p>
          )}
          {s.reasons.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-amber-ink">
              {s.reasons.map((r) => <li key={r}>{describe(r)}</li>)}
            </ul>
          )}
          {s.page_warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-ink-soft">
              {pagesByWarning(s.page_warnings).map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
          {s.rejected_rows.length > 0 && (
            <p className="mt-2 text-xs text-ink-soft">
              Rejected rows:{" "}
              {s.rejected_rows.slice(0, 12).map((r) => `${r.row}${r.page ? ` (p${r.page})` : ""}: ${r.codes.map(describe).join(", ")}`).join("; ")}
              {s.rejected_rows.length > 12 && ` and ${s.rejected_rows.length - 12} more`}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
