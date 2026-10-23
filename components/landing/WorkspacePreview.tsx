// The landing page's focal point: a small, static picture of the real CA review
// workspace, drawn with the workspace's own dark theme (.theme-ca) and status
// tones. Plain server-rendered HTML and CSS (no image, no script), decorative to
// assistive technology, and captioned as synthetic.

import { TONE_CLASSES, type Tone } from "@/lib/tones";

/**
 * An amount with the rupee sign drawn in the system font. "₹" is outside Plex Sans's basic Latin file, and
 * rendering it in Plex would download a second, 25 KB font file for one glyph on this page.
 */
function Money({ value }: { value: string }) {
  const [sign, rest] = value.split("₹");
  return <>{sign}<span className="font-[system-ui]">{"₹"}</span>{rest}</>;
}

/** The status pill at preview size: the same tone colours as Badge, smaller. */
function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`rounded-full px-2 py-px text-[10px] font-medium ${TONE_CLASSES[tone]}`}>{children}</span>;
}

const ROWS: { narration: string; meta: string; amount: string; credit: boolean; status: string; tone: Tone; selected?: boolean }[] = [
  { narration: "NEFT SALARY / DEMO SYSTEMS PVT LTD", meta: "#3 · 02 Apr", amount: "+₹85,000.00", credit: true, status: "Confirm category", tone: "warning", selected: true },
  { narration: "UPI / FOODHUB / 845912", meta: "#4 · 03 Apr", amount: "−₹428.00", credit: false, status: "Auto-classified", tone: "success" },
  { narration: "NEFT-SYNTH0099-UNKNOWN PARTY", meta: "#6 · 05 Apr", amount: "+₹60,000.00", credit: true, status: "Classify manually", tone: "danger" },
  { narration: "NACH MUTUAL FUND SIP / DEMO AMC", meta: "#7 · 05 Apr", amount: "−₹5,000.00", credit: false, status: "Reviewed by CA", tone: "neutral" },
];

export function WorkspacePreview() {
  return (
    <figure className="relative">
      <div aria-hidden="true"
           className="theme-ca overflow-hidden rounded-2xl border border-line bg-paper text-ink shadow-[0_40px_80px_-40px_rgba(16,20,33,0.55)] ring-1 ring-black/5">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="size-2 rounded-full bg-paper-deep" />
          <span className="size-2 rounded-full bg-paper-deep" />
          <span className="size-2 rounded-full bg-paper-deep" />
          <span className="ml-2 truncate text-[11px] tabular-nums text-ink-faint">IT-DEMO-PF9MG1 · Transactions</span>
        </div>
        <div className="flex gap-4 border-b border-line px-4 text-[11px]">
          <span className="py-2 text-ink-soft">Overview</span>
          <span className="flex items-center gap-1.5 border-b-2 border-accent py-2 font-semibold">
            Transactions <span className="rounded-full bg-warning-bg px-1.5 text-warning-fg">2</span>
          </span>
          <span className="py-2 text-ink-soft">Documents</span>
          <span className="hidden py-2 text-ink-soft sm:inline">Summary</span>
        </div>
        <div className="grid sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <ul className="divide-y divide-line">
            {ROWS.map((r) => (
              <li key={r.meta} className={`border-l-2 px-3 py-2.5 ${r.selected ? "border-accent bg-accent-bg" : "border-transparent"}`}>
                <div className="flex items-start justify-between gap-2 text-[11.5px]">
                  <span className="min-w-0 truncate">{r.narration}</span>
                  <span className={`shrink-0 tabular-nums ${r.credit ? "text-teal-deep" : ""}`}><Money value={r.amount} /></span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className={`text-[10px] ${r.selected ? "text-ink-soft" : "text-ink-faint"}`}>{r.meta}</span>
                  <Pill tone={r.tone}>{r.status}</Pill>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden border-l border-line bg-surface p-4 text-[11.5px] sm:block">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">Transaction #3</span>
              <Pill tone="warning">Confirm category</Pill>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
              <div><dt className="text-[10px] text-ink-faint">Credit</dt><dd className="tabular-nums"><Money value={"₹85,000.00"} /></dd></div>
              <div><dt className="text-[10px] text-ink-faint">Mode</dt><dd>NEFT</dd></div>
              <div className="col-span-2"><dt className="text-[10px] text-ink-faint">Why</dt>
                <dd className="text-ink-soft">Narration mentions salary; the payer is not a listed employer.</dd></div>
            </dl>
            <div className="mt-3 rounded-md border border-control px-2 py-1.5">Salary / Pension</div>
            <div className="mt-2 inline-block rounded-md bg-accent px-2.5 py-1 font-medium text-on-accent">Confirm category</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 text-[11px] text-ink-soft">
          <span>Balance check <span className="font-semibold text-teal-deep">PASS</span></span>
          <span>38 rows read</span>
          <span className="hidden sm:inline">1 required document outstanding</span>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-ink-faint">The CA review workspace, shown with synthetic data.</figcaption>
    </figure>
  );
}
