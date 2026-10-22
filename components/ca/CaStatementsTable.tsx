import Link from "next/link";
import type { CaStatement } from "@/lib/ca-session";
import { describe, pagesByWarning, STATUS_LABELS, STATUS_TONES } from "@/lib/statements";

// Statement uploads for the signed-in CA's firm only (the API scopes them).
// Results only: no file contents, no download links.
export function CaStatementsTable({ statements }: { statements: CaStatement[] }) {
  return (
    <section aria-labelledby="statements" className="mt-8 overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h2 id="statements" className="text-lg font-semibold tracking-tight">Statement uploads</h2>
        <p className="mt-1 text-sm text-ink-soft">
          An upload or a successful extraction does not mean a case is ready for review. Files cannot be downloaded
          here yet.
        </p>
      </div>
      {statements.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-ink-soft">No statements have been uploaded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-paper text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">Case</th>
                <th scope="col" className="px-5 py-3 font-medium">Bank</th>
                <th scope="col" className="px-5 py-3 font-medium">Uploaded</th>
                <th scope="col" className="px-5 py-3 font-medium">File</th>
                <th scope="col" className="px-5 py-3 font-medium">Status</th>
                <th scope="col" className="px-5 py-3 font-medium">Rows</th>
                <th scope="col" className="px-5 py-3 font-medium">Review notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line align-top">
              {statements.map((s) => (
                <tr key={s.id}>
                  <td className="px-5 py-3.5">
                    <Link href={`/ca/cases/${encodeURIComponent(s.case_reference)}`}
                          className="font-mono text-[13px] text-teal underline">
                      {s.case_reference}
                    </Link>
                    <span className="block text-xs text-ink-faint">{s.client_first_name} · FY {s.financial_year}</span>
                  </td>
                  <td className="px-5 py-3.5 text-ink-soft">{s.bank_name ?? "—"}</td>
                  <td className="px-5 py-3.5 text-ink-soft">{s.uploaded_at.slice(0, 16).replace("T", " ")}</td>
                  <td className="px-5 py-3.5 text-ink-soft">
                    {s.file_type.toUpperCase()}
                    {s.pages_total !== null && <span className="block text-xs">{s.pages_total} pages</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_TONES[s.status]}`}>
                      {STATUS_LABELS[s.status]}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 tabular-nums text-ink-soft">
                    {s.status === "rejected" ? "—" : (
                      <>
                        {s.rows_extracted} read
                        {s.rows_rejected > 0 && <span className="block text-rose-ink">{s.rows_rejected} rejected</span>}
                        {s.rows_duplicate > 0 && <span className="block text-amber-ink">{s.rows_duplicate} duplicate-looking</span>}
                      </>
                    )}
                  </td>
                  <td className="max-w-sm px-5 py-3.5 text-xs text-ink-soft">
                    {s.error_code && <p className="text-rose-ink">{describe(s.error_code)}</p>}
                    {s.reasons.map((r) => <p key={r}>{describe(r)}</p>)}
                    {pagesByWarning(s.page_warnings).map((w) => <p key={w}>{w}</p>)}
                    {!s.error_code && s.reasons.length === 0 && s.page_warnings.length === 0 && "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
