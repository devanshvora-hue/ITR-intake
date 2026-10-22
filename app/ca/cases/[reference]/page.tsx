import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CaseChecklist } from "@/components/ca/case/CaseChecklist";
import { CaseDocumentRequests } from "@/components/ca/case/CaseDocumentRequests";
import { CaseReviewPanel } from "@/components/ca/case/CaseReviewPanel";
import { CaseStatements } from "@/components/ca/case/CaseStatements";
import { getCaCase } from "@/lib/ca-case";
import { CASE_STATUS_LABELS } from "@/lib/case-status";
import { INCOME_SOURCES } from "@/lib/checklist";
import { CA_INTAKE_STEP_LABELS } from "@/lib/intake";

export const metadata: Metadata = { title: "Case · ITR Intake" };
// Checked on every request: the API verifies the CA session and returns only
// a case of the signed-in CA's own firm.
export const dynamic = "force-dynamic";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <Link href="/ca" className="text-sm font-medium text-teal underline">← Back to dashboard</Link>
      {children}
    </div>
  );
}

export default async function CaCasePage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const result = await getCaCase(reference);
  if (result.state === "signed_out") redirect("/ca/login");
  if (result.state === "not_found") {
    return (
      <Shell>
        <h1 className="mt-6 font-serif text-3xl font-medium tracking-tight">Case not found</h1>
        <p className="mt-3 text-sm text-ink-soft">There is no case with this reference in your firm.</p>
      </Shell>
    );
  }
  if (result.state === "unavailable") {
    return (
      <Shell>
        <h1 className="mt-6 font-serif text-3xl font-medium tracking-tight">Case</h1>
        <p className="mt-4 rounded-lg bg-rose-wash px-4 py-3 text-sm text-rose-ink">
          The ITR Intake server is not reachable, so this case cannot be shown. Start it, then reload.
        </p>
      </Shell>
    );
  }

  const { case: c, intake, profile, statements, review, document_requests, checklist } = result.detail;
  const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—");
  return (
    <Shell>
      <header className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">Case {c.reference}</p>
          <h1 className="mt-3 font-serif text-3xl font-medium tracking-tight sm:text-4xl">
            {profile.full_name ?? c.client_first_name}
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            {c.client_email}{c.client_email_verified ? "" : " (email not verified)"} · FY {c.financial_year} · opened{" "}
            {c.created_at.slice(0, 10)}
          </p>
        </div>
        <span className="rounded-full bg-paper-deep px-3 py-1 text-sm font-medium">
          {CASE_STATUS_LABELS[c.status] ?? c.status}
        </span>
      </header>

      <dl className="mt-6 grid gap-4 rounded-2xl border border-line bg-white p-5 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-soft">Bank</dt>
          <dd className="mt-1 font-medium">{profile.bank_name ?? "Not provided"}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Account</dt>
          <dd className="mt-1 font-medium">{profile.account_last4 ? `ending ${profile.account_last4}` : "Not provided"}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Client details</dt>
          <dd className="mt-1 font-medium">{profile.complete ? "Complete" : "Incomplete"}</dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="text-xs text-ink-soft">Client said these applied in FY {c.financial_year}</dt>
          <dd className="mt-1 font-medium">
            {profile.income_sources.length
              ? profile.income_sources.map((code) => INCOME_SOURCES.find((s) => s.code === code)?.label ?? code).join(" · ")
              : "Nothing selected"}
          </dd>
        </div>
        <div className="sm:col-span-3">
          <dt className="text-xs text-ink-soft">Client intake</dt>
          <dd className="mt-1 flex flex-wrap gap-x-6 gap-y-1">
            {intake.steps.map((s) => (
              <span key={s.key} className={s.done ? "text-teal-deep" : "font-medium text-amber-ink"}>
                {s.done ? "✓" : "○"} {CA_INTAKE_STEP_LABELS[s.key]}
                {!s.done && s.key === "documents" ? ` (${s.outstanding} outstanding)` : ""}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Last updated</dt>
          <dd className="mt-1">{when(c.updated_at)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Last client upload</dt>
          <dd className="mt-1">{when(intake.last_client_upload_at)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-soft">Review prepared</dt>
          <dd className="mt-1">{when(c.reviewed_at)}</dd>
        </div>
      </dl>

      <CaseStatements reference={c.reference} statements={statements} review={review} caseClosed={c.status === "closed"} />
      <CaseReviewPanel reference={c.reference} review={review} />
      <CaseChecklist reference={c.reference} items={checklist} caseClosed={c.status === "closed"} />
      <CaseDocumentRequests reference={c.reference} requests={document_requests}
                            caseClosed={c.status === "closed"} />
    </Shell>
  );
}
