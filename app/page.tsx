import Link from "next/link";

const steps = [
  {
    title: "Statement & details",
    body: "The client shares a bank statement and a few basic details to open their intake.",
  },
  {
    title: "Transaction review",
    body: "Transactions are extracted and checked, and an internal workbook is prepared for the firm.",
  },
  {
    title: "Guided clarification",
    body: "The client answers follow-up questions about specific entries, each shaped by earlier answers.",
  },
  {
    title: "Document checklist",
    body: "A personalised list of supporting documents is generated and collected from the client.",
  },
  {
    title: "CA review",
    body: "The CA reviews the workbook, answers, documents and any open issues in one place.",
  },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <section className="grid gap-10 py-14 md:grid-cols-[1.4fr_1fr] md:py-20">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">
            Client onboarding for CA firms
          </p>
          <h1 className="mt-4 max-w-xl font-serif text-4xl leading-[1.1] font-medium tracking-tight sm:text-5xl">
            Collect the right documents the first time.
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-soft">
            ITR Intake turns a client&rsquo;s bank statement into focused
            questions and a tailored document checklist, so the firm starts
            each return with fewer back-and-forth emails.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/client"
              className="rounded-lg bg-teal px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-deep"
            >
              Open client portal
            </Link>
            <Link
              href="/ca"
              className="rounded-lg border border-line bg-white px-5 py-2.5 text-sm font-medium transition-colors hover:border-ink-faint"
            >
              Open CA dashboard
            </Link>
          </div>
        </div>

        <aside className="self-start rounded-2xl border border-line bg-white p-6">
          <h2 className="font-serif text-lg font-medium">Two separate views</h2>
          <dl className="mt-4 space-y-4 text-sm">
            <div>
              <dt className="font-medium">Client portal</dt>
              <dd className="mt-1 text-ink-soft">
                Shares details, answers questions and uploads documents. Never
                sees the firm&rsquo;s internal workbook.
              </dd>
            </div>
            <div className="border-t border-line pt-4">
              <dt className="font-medium">CA dashboard</dt>
              <dd className="mt-1 text-ink-soft">
                Tracks every intake, with the workbook, answers and documents
                ready for review.
              </dd>
            </div>
          </dl>
        </aside>
      </section>

      <section className="border-t border-line py-14">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-serif text-2xl font-medium">How an intake moves</h2>
          <p className="text-sm text-ink-faint">
            Stage 1 prototype: the interface only. The steps below are not yet
            functional.
          </p>
        </div>
        <ol className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {steps.map((step, i) => (
            <li key={step.title} className="rounded-xl border border-line bg-white p-5">
              <span className="font-mono text-xs text-teal">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 font-medium">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
