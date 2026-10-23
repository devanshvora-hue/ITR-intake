import type { Metadata } from "next";
import { ClientCaseForm } from "@/components/client/ClientCaseForm";
import { ClientChecklist } from "@/components/client/ClientChecklist";
import { ClientLogoutButton } from "@/components/client/ClientLogoutButton";
import { ClientProfileForm } from "@/components/client/ClientProfileForm";
import { ClientResumeCode } from "@/components/client/ClientResumeCode";
import { ClientStartForm } from "@/components/client/ClientStartForm";
import { DocumentRequests } from "@/components/client/DocumentRequests";
import { StatementList } from "@/components/client/StatementList";
import { StatementUploader } from "@/components/client/StatementUploader";
import { Badge } from "@/components/ui/Badge";
import { getClientSession, type ClientCase, type ClientMe } from "@/lib/client-session";
import { clientNextStep, INTAKE_STEP_LABELS } from "@/lib/intake";

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

const card = "rounded-2xl border border-line bg-surface";

// --- signed out: the welcome ------------------------------------------------------------------------------

// The three things a client actually does here, in order.
const STEPS = [
  { title: "Enter your CA's firm code", body: "With your email address. You are signed in straight away; there is no password." },
  { title: "Add your details and bank statement", body: "Your name, bank and the last four digits of the account, then a statement for the year." },
  { title: "Upload what your CA asks for", body: "Requested documents appear here. Everything is saved as you go." },
];

function Welcome({ unavailable }: { unavailable: boolean }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-16">
      {/* Phones: headline, form, then the steps. Wide screens: the form in its own column beside both. */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-14">
        <div className="lg:col-start-1 lg:row-start-1">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">Client portal</p>
          <h1 className="mt-3 max-w-xl font-serif text-3xl font-medium leading-tight tracking-tight sm:text-[2.6rem]">
            Share what your CA needs for your income tax return.
          </h1>
          <p className="mt-4 max-w-lg leading-relaxed text-ink-soft">
            Your CA&rsquo;s firm uses this portal to collect your bank statement and supporting documents in one place.
          </p>
        </div>

        <section aria-labelledby="begin" className={`${card} self-start p-5 sm:p-7 lg:col-start-2 lg:row-span-2 lg:row-start-1`}>
          <h2 id="begin" className="text-lg font-semibold tracking-tight">Start or continue your intake</h2>
          <p className="mt-1.5 text-sm text-ink-soft">
            When you first start you get a <span className="font-medium text-ink">resume code</span>. Keep it: you need it
            to continue on another device or browser.
          </p>
          {unavailable && (
            <p role="alert" className="mt-4 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg">
              The ITR Intake server is not reachable. Please try again later.
            </p>
          )}
          <div className="mt-5">
            <ClientStartForm />
          </div>
          <p className="mt-5 border-t border-line pt-4 text-xs text-ink-faint">
            Please use synthetic details in this prototype. Your CA&rsquo;s internal working files stay with the firm and are
            not shown here.
          </p>
        </section>

        <ol aria-label="How it works" className="max-w-lg space-y-5 lg:col-start-1 lg:row-start-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-4">
              <span aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface font-mono text-xs text-teal">
                {i + 1}
              </span>
              <div>
                <p className="font-medium">{s.title}</p>
                <p className="mt-0.5 text-sm text-ink-soft">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// --- signed in: one workspace per intake ------------------------------------------------------------------

function StepTrack({ c }: { c: ClientCase }) {
  return (
    <ol aria-label="Your progress" className="grid gap-2 sm:grid-cols-3">
      {c.intake.steps.map((s, i) => (
        <li key={s.key}
            className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm ${s.done ? "border-line bg-success-bg" : "border-line bg-surface"}`}>
          <span aria-hidden="true"
                className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${s.done
                  ? "bg-success-fg text-white" : "border border-control text-ink-soft"}`}>
            {s.done ? "✓" : i + 1}
          </span>
          <span className="min-w-0">
            <span className="block font-medium">{INTAKE_STEP_LABELS[s.key]}</span>
            <span className={`block text-xs ${s.done ? "text-success-fg" : "text-ink-faint"}`}>
              {s.done ? "Done" : s.key === "documents" && s.outstanding ? `${s.outstanding} still needed` : "To do"}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function Section({ id, title, children, aside }: { id: string; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className={`${card} scroll-mt-6 p-5 sm:p-6`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={id} className="text-base font-semibold tracking-tight">{title}</h3>
        {aside}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function IntakeCase({ c, me }: { c: ClientCase; me: ClientMe }) {
  const id = (part: string) => `${part}-${c.reference}`;
  const closed = c.status === "closed";
  const next = clientNextStep(c.intake, c.status, c.statements.map((s) => s.status));
  const nextHref = next.key === "details" ? `#${id("details")}` : next.key === "statement" ? `#${id("statement")}`
    : next.key === "documents" ? `#${id("requested")}` : null;
  const outstanding = c.document_requests.filter((r) => r.status === "requested").length;

  return (
    <article aria-labelledby={id("case")} className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={id("case")} className="font-serif text-2xl font-medium tracking-tight">Financial year {c.financial_year}</h2>
          <p className="mt-1 font-mono text-xs text-ink-faint">
            {c.reference} · started {c.created_at.slice(0, 10)}
          </p>
        </div>
        <Badge tone={closed ? "neutral" : "accent"} size="md">{STATUS_LABELS[c.status] ?? c.status}</Badge>
      </header>

      <StepTrack c={c} />

      <div className={`rounded-2xl border px-5 py-4 ${next.key === "done" ? "border-line bg-success-bg" : "border-accent/30 bg-accent-bg"}`}>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">
          {next.key === "done" || next.key === "closed" ? "Status" : "Your next step"}
        </p>
        <p className="mt-1 text-lg font-semibold tracking-tight">{next.title}</p>
        <p className="mt-0.5 text-sm text-ink-soft">{next.detail}</p>
        {nextHref && (
          <a href={nextHref} className="mt-3 inline-block text-sm font-medium text-teal underline underline-offset-2">Go to it</a>
        )}
      </div>

      <Section id={id("details")} title="Your details">
        <ClientProfileForm reference={c.reference} financialYear={c.financial_year} profile={c.profile} />
      </Section>

      <Section id={id("statement")} title="Bank statement">
        <StatementUploader reference={c.reference} limits={me.upload_limits} disabled={!c.profile.complete} />
        {c.statements.length > 0 && (
          <div className="mt-5 border-t border-line pt-5">
            <h4 className="text-sm font-medium">Uploaded statements</h4>
            <div className="mt-3"><StatementList statements={c.statements} /></div>
          </div>
        )}
      </Section>

      <Section id={id("requested")} title="Documents your CA asked for"
               aside={c.document_requests.length > 0 && (
                 <span className="text-xs text-ink-soft">{outstanding} waiting · {c.document_requests.length} in all</span>
               )}>
        <DocumentRequests reference={c.reference} requests={c.document_requests} caseClosed={closed} />
      </Section>

      <Section id={id("suggested")} title="Documents you may need">
        <ClientChecklist reference={c.reference} items={c.checklist} caseClosed={closed} />
      </Section>
    </article>
  );
}

function SignedIn({ me }: { me: ClientMe }) {
  const startForm = me.can_open_case ? <ClientCaseForm years={me.financial_years} /> : (
    <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger-fg">
      The firm code you used is no longer active, so a new intake cannot be started. Please ask your CA for their current
      code and start again.
    </p>
  );
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">Client portal · {me.firm.name}</p>
          <h1 className="mt-2 font-serif text-3xl font-medium tracking-tight">Your income tax intake</h1>
          <p className="mt-2 break-words text-sm text-ink-soft">
            Signed in as <span className="font-medium text-ink">{me.client.email}</span>. Your answers and uploads are saved
            as you go.
          </p>
          <div className="mt-2"><ClientResumeCode /></div>
        </div>
        <ClientLogoutButton />
      </header>

      {me.cases.length === 0 ? (
        <section aria-labelledby="start" className={`${card} mt-8 p-5 sm:p-7`}>
          <h2 id="start" className="text-lg font-semibold tracking-tight">Start your intake</h2>
          <p className="mt-1 text-sm text-ink-soft">You have not started an intake with {me.firm.name} yet.</p>
          <div className="mt-5">{startForm}</div>
        </section>
      ) : (
        <div className="mt-8 space-y-12">
          {me.cases.map((c) => <IntakeCase key={c.reference} c={c} me={me} />)}
          <details className={`${card} p-5 sm:p-6`}>
            <summary className="cursor-pointer text-sm font-medium">Start an intake for another financial year</summary>
            <div className="mt-5">{startForm}</div>
          </details>
        </div>
      )}
    </div>
  );
}

export default async function ClientPortal() {
  const session = await getClientSession();
  if (session.state === "signed_in") return <SignedIn me={session.me} />;
  return <Welcome unavailable={session.state === "unavailable"} />;
}
