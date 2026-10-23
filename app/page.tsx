import Link from "next/link";
import { SiteChrome } from "@/components/SiteChrome";
import { WorkspacePreview } from "@/components/landing/WorkspacePreview";
import { buttonClasses } from "@/components/ui/Button";

// The public landing page. Server-rendered and static: no client script of its
// own, no images (the hero visual is HTML and CSS), only the site's own fonts.
// Every claim describes something the application does today.

// Small-caps labels in Plex Sans: the landing page never needs Plex Mono, so it is never downloaded here.
const eyebrow = "text-xs font-semibold uppercase tracking-[0.16em] text-teal";

const WORKFLOW = [
  {
    title: "The client shares",
    body: "With your firm code and their email, the client adds their details, uploads a bank statement (PDF or CSV) and any documents you request. No password to set up.",
  },
  {
    title: "The statement is read and checked",
    body: "Every row is extracted and validated, and the balances are reconciled: opening plus credits minus debits against the closing balance.",
  },
  {
    title: "You review the transactions",
    body: "Each transaction gets one of 28 categories from fixed rules, with the reason and a confidence. You confirm or change the uncertain ones, with notes, and can undo.",
  },
  {
    title: "Documents and the ITR summary",
    body: "Suggested documents follow from the client's answers and the statement. Request what you need, then download an internal ITR summary workbook.",
  },
];

const FOR_FIRMS = [
  "A priority queue that puts blocked cases first",
  "One firm code to share with every client",
  "A transaction review workspace with keyboard navigation",
  "Document requests you can waive or reopen",
  "An ITR summary with points to verify, as an Excel workbook",
];

const FOR_CLIENTS = [
  "No password: firm code, email and a resume code",
  "One clear next step on every intake",
  "Statement upload with an immediate result",
  "Only the documents their CA actually asks for",
  "Asked for the last four digits of an account, never the full number",
];

const PRINCIPLES = [
  { title: "Rules you can read", body: "Categories come from fixed, documented rules. Each one shows why it was chosen and how sure the rules are." },
  { title: "Your decisions are kept", body: "Decisions survive reading the statement again. If a row now reads differently, the old decision is flagged, not silently applied." },
  { title: "Each firm sees only its own", body: "Cases, documents and decisions are scoped to the signed-in firm on every request." },
  { title: "Preparation, not filing", body: "ITR Intake organises the client's information. It does not compute tax or file returns; your CA does." },
];

function Check() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" className="mt-0.5 shrink-0 text-teal">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Home() {
  return (
    <SiteChrome>
      <Landing />
    </SiteChrome>
  );
}

function Landing() {
  return (
    <>
      {/* Hero: what it is, who it is for, and the next action, above the fold. */}
      <section aria-labelledby="hero" className="relative overflow-hidden border-b border-line">
        <div aria-hidden="true"
             className="pointer-events-none absolute inset-0 bg-[radial-gradient(56rem_28rem_at_85%_-10%,var(--color-accent-bg),transparent_70%)]" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:gap-14 lg:py-24">
          <div>
            <p className={eyebrow}>Client intake for Indian CA firms</p>
            <h1 id="hero" className="mt-4 text-balance font-serif text-[2.35rem] font-medium leading-[1.06] tracking-tight sm:text-5xl lg:text-[3.35rem]">
              From a client&rsquo;s bank statement to a reviewed ITR workbook.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
              Collect each client&rsquo;s statement and documents in one place, review every transaction with rules you can
              read, and hand your team an ITR summary instead of a folder of emails.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/ca/register" className={buttonClasses({ size: "lg" })}>Register your firm</Link>
              <Link href="/client" className={buttonClasses({ variant: "secondary", size: "lg" })}>Start a client intake</Link>
            </div>
            <p className="mt-4 text-sm text-ink-soft">
              Already registered?{" "}
              <Link href="/ca/login" className="font-medium text-teal underline underline-offset-2">Sign in</Link>
            </p>
          </div>
          <WorkspacePreview />
        </div>
      </section>

      {/* How it works */}
      <section aria-labelledby="workflow" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="max-w-2xl">
          <p className={eyebrow}>How an intake moves</p>
          <h2 id="workflow" className="mt-3 text-balance font-serif text-3xl font-medium tracking-tight sm:text-4xl">
            Four steps, with your team&rsquo;s attention where judgement is needed.
          </h2>
        </div>
        <ol className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {WORKFLOW.map((step, i) => (
            <li key={step.title} className="relative border-t border-line pt-5">
              <span aria-hidden="true" className="absolute -top-px left-0 h-0.5 w-10 bg-accent" />
              <p className="text-xs font-medium tabular-nums text-ink-faint">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-2 font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Both sides */}
      <section aria-labelledby="sides" className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <h2 id="sides" className="max-w-2xl text-balance font-serif text-3xl font-medium tracking-tight sm:text-4xl">
            One intake, two views.
          </h2>
          <p className="mt-3 max-w-2xl text-ink-soft">
            Your firm works in a focused dark workspace. Your clients see a calm portal with only what they need to do.
          </p>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {[
              { id: "firms", title: "For your firm", items: FOR_FIRMS, href: "/ca/register", cta: "Register your firm" },
              { id: "clients", title: "For your clients", items: FOR_CLIENTS, href: "/client", cta: "Open the client portal" },
            ].map((side) => (
              <div key={side.id} className="flex flex-col rounded-2xl border border-line bg-paper p-6 sm:p-7">
                <h3 className="text-lg font-semibold tracking-tight">{side.title}</h3>
                <ul className="mt-4 flex-1 space-y-3 text-sm">
                  {side.items.map((item) => (
                    <li key={item} className="flex gap-3"><Check /><span>{item}</span></li>
                  ))}
                </ul>
                <Link href={side.href} className="mt-6 text-sm font-medium text-teal underline underline-offset-2">
                  {side.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Principles */}
      <section aria-labelledby="principles" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <p className={eyebrow}>Careful by design</p>
        <h2 id="principles" className="mt-3 max-w-2xl text-balance font-serif text-3xl font-medium tracking-tight sm:text-4xl">
          Built for work that has to be right.
        </h2>
        <dl className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <div key={p.title}>
              <dt className="font-semibold tracking-tight">{p.title}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-ink-soft">{p.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Final call to action, in the workspace's own dark palette */}
      <section aria-labelledby="start" className="px-4 pb-16 sm:px-6 sm:pb-20">
        <div className="theme-ca mx-auto max-w-6xl rounded-3xl bg-paper px-6 py-12 text-ink sm:px-12 sm:py-14">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-xl">
              <h2 id="start" className="text-3xl font-semibold tracking-tight sm:text-4xl">Your firm is ready as soon as you register.</h2>
              <p className="mt-3 text-ink-soft">
                Register, share your firm code with clients, and their cases arrive in your priority queue.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/ca/register" className={buttonClasses({ size: "lg" })}>Register your firm</Link>
              <Link href="/ca/login" className={buttonClasses({ variant: "secondary", size: "lg" })}>Sign in</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
