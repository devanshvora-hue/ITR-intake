import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CaStatementsTable } from "@/components/ca/CaStatementsTable";
import { FirmCodePanel } from "@/components/ca/FirmCodePanel";
import { LogoutButton } from "@/components/ca/LogoutButton";
import { getCaSession } from "@/lib/ca-session";
import { needsAttention, nextAction, STATEMENT_LABELS, STATEMENT_TONES } from "@/lib/case-readiness";
import { CASE_STATUS_LABELS as STATUS_LABELS } from "@/lib/case-status";

export const metadata: Metadata = { title: "CA dashboard · ITR Intake" };
// Checked on every request: the API verifies the session (idle and absolute
// expiry) and returns data for the signed-in CA's own firm only.
export const dynamic = "force-dynamic";

export default async function CaDashboard() {
  const session = await getCaSession({ withCases: true, withFirmCode: true, withStatements: true });
  if (session.state === "signed_out") redirect("/ca/login");
  if (session.state === "unavailable") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <h1 className="font-serif text-3xl font-medium tracking-tight">CA dashboard</h1>
        <p className="mt-4 rounded-lg bg-rose-wash px-4 py-3 text-sm text-rose-ink">
          The ITR Intake server is not reachable, so no dashboard data can be shown. Start it, then reload.
        </p>
      </div>
    );
  }

  const { me, cases, firmCode, statements } = session;
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">CA dashboard</p>
          <h1 className="mt-3 font-serif text-3xl font-medium tracking-tight sm:text-4xl">{me.firm.name}</h1>
          <p className="mt-2 text-sm text-ink-soft">
            Signed in as <span className="font-medium text-ink">{me.user.full_name}</span> ({me.user.email}) ·{" "}
            {me.user.role === "owner" ? "Firm owner" : "Member"}
          </p>
        </div>
        <LogoutButton />
      </header>

      <section aria-label="Summary" className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "Cases", value: cases.length },
          { label: "Open", value: cases.filter((c) => c.status !== "closed").length },
          { label: "Need CA review", value: cases.filter((c) => c.status === "ca_review_required").length },
          { label: "Need attention", value: cases.filter((c) => needsAttention(c.status, c.readiness)).length },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-line bg-white p-5">
            <p className="text-sm text-ink-soft">{s.label}</p>
            <p className="mt-2 font-serif text-3xl font-medium tabular-nums">{s.value}</p>
          </div>
        ))}
      </section>

      {firmCode && <FirmCodePanel initial={firmCode} />}

      <section aria-labelledby="cases" className="mt-10 overflow-hidden rounded-2xl border border-line bg-white">
        <div className="border-b border-line px-5 py-4">
          <h2 id="cases" className="font-serif text-lg font-medium">Client cases</h2>
          <p className="mt-1 text-xs text-ink-faint">
            Highlighted cases have an unverified statement review or an outstanding required document. These are
            checklist items from stored data, not a judgement that a return is ready to file.
          </p>
        </div>
        {cases.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="font-medium">No client cases yet.</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
              {firmCode?.active
                ? `Share your firm code (${firmCode.active.display}) with clients. When they start an intake at the client portal, their cases appear here.`
                : "Generate a firm code above and share it with clients. When they start an intake at the client portal, their cases appear here."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="bg-paper text-xs uppercase tracking-wide text-ink-faint">
                <tr>
                  <th scope="col" className="px-5 py-3 font-medium">Reference</th>
                  <th scope="col" className="px-5 py-3 font-medium">Client</th>
                  <th scope="col" className="px-5 py-3 font-medium">Financial year</th>
                  <th scope="col" className="px-5 py-3 font-medium">Status</th>
                  <th scope="col" className="px-5 py-3 font-medium">Statement</th>
                  <th scope="col" className="px-5 py-3 font-medium">Required documents</th>
                  <th scope="col" className="px-5 py-3 font-medium">Next step</th>
                  <th scope="col" className="px-5 py-3 font-medium">Last updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {cases.map((c) => {
                  const r = c.readiness;
                  const flagged = needsAttention(c.status, r);
                  return (
                  <tr key={c.reference} className={flagged ? "bg-amber-wash/40" : undefined}>
                    <td className="px-5 py-3.5 font-mono text-[13px]">
                      <Link href={`/ca/cases/${encodeURIComponent(c.reference)}`} className="text-teal underline">
                        {c.reference}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="font-medium">{c.profile.full_name ?? c.client_first_name}</span>
                      <span className="block text-xs text-ink-faint">{c.client_email}</span>
                    </td>
                    <td className="px-5 py-3.5 text-ink-soft">{c.financial_year}</td>
                    <td className="px-5 py-3.5">{STATUS_LABELS[c.status] ?? c.status}</td>
                    <td className="px-5 py-3.5">
                      <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${STATEMENT_TONES[r.statement]}`}>
                        {STATEMENT_LABELS[r.statement]}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-xs">
                      {r.documents.total_requests === 0 ? (
                        <span className="text-ink-faint">None requested</span>
                      ) : (
                        <span className="whitespace-nowrap">
                          <span className={r.documents.required_outstanding > 0 ? "font-medium text-amber-ink" : ""}>
                            {r.documents.required_outstanding} outstanding
                          </span>
                          {" · "}{r.documents.required_received} received · {r.documents.required_waived} waived
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <Link href={`/ca/cases/${encodeURIComponent(c.reference)}`}
                            className={flagged ? "font-medium text-amber-ink underline" : "text-teal underline"}>
                        {nextAction(c.status, r)}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5 text-ink-soft">{c.updated_at.slice(0, 10)}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CaStatementsTable statements={statements} />
    </div>
  );
}
