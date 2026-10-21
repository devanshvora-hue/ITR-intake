import type { Metadata } from "next";
import { PlaceholderTag } from "@/components/PlaceholderTag";

export const metadata: Metadata = { title: "Client portal · ITR Intake" };

const fields = [
  { id: "name", label: "Full name", placeholder: "As on PAN card", type: "text" },
  { id: "email", label: "Email", placeholder: "name@example.com", type: "email" },
  { id: "phone", label: "Mobile number", placeholder: "10-digit mobile", type: "tel" },
  { id: "fy", label: "Financial year", placeholder: "FY 2025-26", type: "text" },
];

const nextSteps = [
  {
    title: "Guided clarification",
    body: "We'll ask short questions about specific transactions in your statement. Each question depends on what you've already told us, so you only answer what's relevant.",
  },
  {
    title: "Your document checklist",
    body: "Based on your answers, you'll get a personalised list of supporting documents, such as Form 16, rent receipts or investment proofs, and a place to upload each one.",
  },
  {
    title: "Review by your CA",
    body: "Your CA reviews everything you've shared and contacts you only if something is still unclear.",
  },
];

export default function ClientPortal() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">Client portal</p>
        <h1 className="mt-3 font-serif text-3xl font-medium tracking-tight sm:text-4xl">
          Start your income tax intake
        </h1>
        <p className="mt-4 leading-relaxed text-ink-soft">
          Share your bank statement and a few details. Your CA&rsquo;s team uses
          them to prepare focused questions and a document checklist for you.
        </p>
      </header>

      <div className="mt-6 rounded-xl border border-dashed border-ink-faint/50 bg-paper-deep px-4 py-3 text-sm text-ink-soft">
        <strong className="font-medium text-ink">Preview only.</strong> This
        page shows the intake layout. Nothing here can be submitted or uploaded
        yet, and no data is stored.
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section aria-labelledby="statement" className="rounded-2xl border border-line bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="statement" className="font-serif text-xl font-medium">
              1. Bank statement
            </h2>
            <PlaceholderTag>Upload not yet available</PlaceholderTag>
          </div>
          <p className="mt-2 text-sm text-ink-soft">
            Your full statement for the financial year, as a PDF from your bank.
          </p>
          <div
            aria-disabled="true"
            className="mt-5 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-line bg-paper px-6 py-12 text-center"
          >
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-8 w-8 text-ink-faint"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              <path d="M14 3v5h5M12 12v6M9 15l3-3 3 3" />
            </svg>
            <p className="mt-3 text-sm font-medium text-ink-soft">
              Statement upload will appear here
            </p>
            <p className="mt-1 text-xs text-ink-faint">
              PDF bank statements will be accepted in a later stage
            </p>
          </div>
        </section>

        <section aria-labelledby="details" className="rounded-2xl border border-line bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="details" className="font-serif text-xl font-medium">
              2. Your details
            </h2>
            <PlaceholderTag>Form preview</PlaceholderTag>
          </div>
          <fieldset disabled className="mt-5 space-y-4">
            <legend className="sr-only">Initial client details (preview, disabled)</legend>
            {fields.map((f) => (
              <div key={f.id}>
                <label htmlFor={f.id} className="block text-sm font-medium">
                  {f.label}
                </label>
                <input
                  id={f.id}
                  type={f.type}
                  placeholder={f.placeholder}
                  className="mt-1.5 w-full cursor-not-allowed rounded-lg border border-line bg-paper px-3 py-2 text-sm placeholder:text-ink-faint"
                />
              </div>
            ))}
          </fieldset>
          <p className="mt-5 text-xs text-ink-faint">
            Submission will be enabled once secure storage is in place.
          </p>
        </section>
      </div>

      <section aria-labelledby="next" className="mt-12">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="next" className="font-serif text-2xl font-medium">What happens next</h2>
          <PlaceholderTag />
        </div>
        <ol className="mt-6 grid gap-4 md:grid-cols-3">
          {nextSteps.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-line bg-white p-5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-teal-wash font-mono text-xs text-teal-deep">
                {i + 3}
              </span>
              <h3 className="mt-3 font-medium">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-ink-faint">
          Your CA&rsquo;s internal working files stay within the firm and are not
          shown in this portal.
        </p>
      </section>
    </div>
  );
}
