import type { Metadata } from "next";
import { demoCases, type IntakeStatus, type ReviewStatus } from "@/lib/demo-cases";

export const metadata: Metadata = { title: "CA dashboard · ITR Intake" };

const intakeTone: Record<IntakeStatus, string> = {
  "Awaiting statement": "bg-rose-wash text-rose-ink",
  "Clarification in progress": "bg-amber-wash text-amber-ink",
  "Documents pending": "bg-amber-wash text-amber-ink",
  "Intake complete": "bg-teal-wash text-teal-deep",
};

const reviewTone: Record<ReviewStatus, string> = {
  "Not started": "bg-paper-deep text-ink-soft",
  "In review": "bg-teal-wash text-teal-deep",
  "Queries raised": "bg-rose-wash text-rose-ink",
  Reviewed: "bg-ink text-paper",
};

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

export default function CaDashboard() {
  const inIntake = demoCases.filter((c) => c.intakeStatus !== "Intake complete").length;
  const pendingDocs = demoCases.reduce((sum, c) => sum + c.pendingDocuments, 0);
  const readyForReview = demoCases.filter(
    (c) => c.intakeStatus === "Intake complete" && c.reviewStatus !== "Reviewed",
  ).length;

  const stats = [
    { label: "Total cases", value: demoCases.length, note: "Demo set" },
    { label: "Intake in progress", value: inIntake, note: "Client still responding" },
    { label: "Documents outstanding", value: pendingDocs, note: "Across all cases" },
    { label: "Ready for CA review", value: readyForReview, note: "Intake complete" },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">CA dashboard</p>
          <h1 className="mt-3 font-serif text-3xl font-medium tracking-tight sm:text-4xl">
            Intake overview
          </h1>
        </div>
        <p className="rounded-lg border border-dashed border-ink-faint/50 bg-paper-deep px-3 py-2 text-xs text-ink-soft">
          Showing <strong className="font-medium text-ink">synthetic demo cases</strong>. Case
          details and workbooks open in a later stage.
        </p>
      </header>

      <section aria-label="Summary" className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-line bg-white p-5">
            <p className="text-sm text-ink-soft">{s.label}</p>
            <p className="mt-2 font-serif text-3xl font-medium tabular-nums">{s.value}</p>
            <p className="mt-1 text-xs text-ink-faint">{s.note}</p>
          </div>
        ))}
      </section>

      <section
        aria-labelledby="cases"
        className="mt-10 overflow-hidden rounded-2xl border border-line bg-white"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-4">
          <h2 id="cases" className="font-serif text-lg font-medium">
            Cases
          </h2>
          <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">
            Demo data · not real clients
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-paper text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">Client reference</th>
                <th scope="col" className="px-5 py-3 font-medium">Financial year</th>
                <th scope="col" className="px-5 py-3 font-medium">Intake status</th>
                <th scope="col" className="px-5 py-3 text-right font-medium">Pending documents</th>
                <th scope="col" className="px-5 py-3 font-medium">Review status</th>
                <th scope="col" className="px-5 py-3 font-medium">Last updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {demoCases.map((c) => (
                <tr key={c.ref} className="hover:bg-paper/60">
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-[13px] font-medium">{c.ref}</span>
                    <span className="block text-xs text-ink-faint">{c.clientLabel}</span>
                  </td>
                  <td className="px-5 py-3.5 text-ink-soft">{c.financialYear}</td>
                  <td className="px-5 py-3.5">
                    <Chip className={intakeTone[c.intakeStatus]}>{c.intakeStatus}</Chip>
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono tabular-nums">
                    {c.pendingDocuments === 0 ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      c.pendingDocuments
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <Chip className={reviewTone[c.reviewStatus]}>{c.reviewStatus}</Chip>
                  </td>
                  <td className="px-5 py-3.5 text-ink-soft">{c.updated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
