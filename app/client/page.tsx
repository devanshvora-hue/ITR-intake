import type { Metadata } from "next";
import { PlaceholderTag } from "@/components/PlaceholderTag";
import { ClientCaseForm } from "@/components/client/ClientCaseForm";
import { ClientLogoutButton } from "@/components/client/ClientLogoutButton";
import { ClientProfileForm } from "@/components/client/ClientProfileForm";
import { ClientStartForm } from "@/components/client/ClientStartForm";
import { ClientChecklist } from "@/components/client/ClientChecklist";
import { DocumentRequests } from "@/components/client/DocumentRequests";
import { StatementList } from "@/components/client/StatementList";
import { StatementUploader } from "@/components/client/StatementUploader";
import { getClientSession, type ClientMe } from "@/lib/client-session";

export const metadata: Metadata = { title: "Client portal · ITR Intake" };
// Checked on every request: the API resolves the client session cookie.
export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  draft: "Started",
  statement_uploaded: "Statement uploaded",
  processing: "Processing",
  questions_in_progress: "Questions in progress",
  documents_pending: "Documents pending",
  submitted: "Submitted",
  ca_review_required: "With your CA",
  review_ready: "With your CA",
  closed: "Closed",
};

const nextSteps = [
  {
    title: "Guided clarification",
    body: "We'll ask short questions about specific transactions in your statement. Each question depends on what you've already told us, so you only answer what's relevant.",
  },
  {
    title: "Review by your CA",
    body: "Your CA reviews everything you've shared and contacts you only if something is still unclear.",
  },
];

function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">Client portal</p>
        <h1 className="mt-3 font-serif text-3xl font-medium tracking-tight sm:text-4xl">Start your income tax intake</h1>
        <p className="mt-4 leading-relaxed text-ink-soft">
          Your CA&rsquo;s team uses what you share here to prepare focused questions and a document checklist for you.
        </p>
      </div>
      {children}
    </header>
  );
}

function NextSteps() {
  return (
    <section aria-labelledby="next" className="mt-12">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="next" className="font-serif text-2xl font-medium">What happens next</h2>
        <PlaceholderTag>Coming in later stages</PlaceholderTag>
      </div>
      <ol className="mt-6 grid gap-4 md:grid-cols-3">
        {nextSteps.map((s, i) => (
          <li key={s.title} className="rounded-xl border border-line bg-white p-5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-wash font-mono text-xs text-teal-deep">
              {i + 4}
            </span>
            <h3 className="mt-3 font-medium">{s.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-sm text-ink-faint">
        Your CA&rsquo;s internal working files stay within the firm and are not shown in this portal.
      </p>
    </section>
  );
}

function SignedIn({ me }: { me: ClientMe }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <Header>
        <ClientLogoutButton />
      </Header>
      <p className="mt-6 text-sm text-ink-soft">
        Signed in as <span className="font-medium text-ink">{me.client.email}</span> with{" "}
        <span className="font-medium text-ink">{me.firm.name}</span>
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section aria-labelledby="intakes" className="rounded-2xl border border-line bg-white">
          <div className="border-b border-line px-6 py-4">
            <h2 id="intakes" className="font-serif text-xl font-medium">1. Your intakes</h2>
          </div>
          {me.cases.length === 0 ? (
            <p className="px-6 py-10 text-center text-sm text-ink-soft">
              You have not started an intake with {me.firm.name} yet.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {me.cases.map((c) => (
                <li key={c.reference} className="flex flex-wrap items-center justify-between gap-2 px-6 py-4">
                  <div>
                    <p className="font-mono text-[13px]">{c.reference}</p>
                    <p className="mt-0.5 text-sm text-ink-soft">FY {c.financial_year} · started {c.created_at.slice(0, 10)}</p>
                  </div>
                  <span className="rounded-full bg-teal-wash px-3 py-1 text-xs font-medium text-teal-deep">
                    {STATUS_LABELS[c.status] ?? c.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="start" className="rounded-2xl border border-line bg-white p-6">
          <h2 id="start" className="font-serif text-xl font-medium">2. Start an intake</h2>
          {me.can_open_case ? (
            <div className="mt-5">
              <ClientCaseForm years={me.financial_years} />
            </div>
          ) : (
            <p className="mt-4 rounded-lg bg-rose-wash px-3 py-2 text-sm text-rose-ink">
              The firm code you used is no longer active, so a new intake cannot be started. Please ask your CA for
              their current code and start again.
            </p>
          )}
        </section>
      </div>

      {me.cases.map((c) => (
        <section key={c.reference} aria-labelledby={`case-${c.reference}`}
                 className="mt-8 rounded-2xl border border-line bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-6 py-4">
            <h2 id={`case-${c.reference}`} className="font-serif text-xl font-medium">
              3. FY {c.financial_year} statement
            </h2>
            <span className="font-mono text-[13px] text-ink-soft">{c.reference}</span>
          </div>
          <div className="grid gap-8 p-6 lg:grid-cols-2">
            <div>
              <h3 className="font-medium">Your details</h3>
              <div className="mt-4">
                <ClientProfileForm reference={c.reference} financialYear={c.financial_year} profile={c.profile} />
              </div>
            </div>
            <div className="space-y-6">
              <div>
                <h3 className="font-medium">Upload your bank statement</h3>
                <div className="mt-4">
                  <StatementUploader reference={c.reference} limits={me.upload_limits} disabled={!c.profile.complete} />
                </div>
              </div>
              <div>
                <h3 className="font-medium">Uploaded statements</h3>
                <div className="mt-3">
                  <StatementList statements={c.statements} />
                </div>
              </div>
              <div>
                <h3 className="font-medium">Documents you may need</h3>
                <div className="mt-3">
                  <ClientChecklist reference={c.reference} items={c.checklist} caseClosed={c.status === "closed"} />
                </div>
              </div>
              <div>
                <h3 className="font-medium">Documents your CA asked for</h3>
                <div className="mt-3">
                  <DocumentRequests reference={c.reference} requests={c.document_requests}
                                    caseClosed={c.status === "closed"} />
                </div>
              </div>
            </div>
          </div>
        </section>
      ))}

      <NextSteps />
    </div>
  );
}

export default async function ClientPortal() {
  const session = await getClientSession();
  if (session.state === "signed_in") return <SignedIn me={session.me} />;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <Header />
      {session.state === "unavailable" && (
        <p className="mt-6 rounded-lg bg-rose-wash px-4 py-3 text-sm text-rose-ink">
          The ITR Intake server is not reachable. Please try again later.
        </p>
      )}
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <section aria-labelledby="begin" className="rounded-2xl border border-line bg-white p-6">
          <h2 id="begin" className="font-serif text-xl font-medium">1. Find your CA firm</h2>
          <p className="mt-2 text-sm text-ink-soft">
            Enter the firm code your CA gave you and your email address. We&rsquo;ll email you a link to continue.
          </p>
          <div className="mt-5">
            <ClientStartForm />
          </div>
        </section>
        <section aria-labelledby="why" className="rounded-2xl border border-line bg-paper-deep p-6">
          <h2 id="why" className="font-serif text-xl font-medium">2. Confirm your email</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            The link proves the email address is yours. After opening it you choose the financial year, and your
            intake appears in your CA&rsquo;s dashboard. You never need a password.
          </p>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            Please use synthetic details in this prototype.
          </p>
        </section>
      </div>
      <NextSteps />
    </div>
  );
}
