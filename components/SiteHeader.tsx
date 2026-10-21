import Link from "next/link";
import { NavLinks } from "./NavLinks";

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-serif text-xl font-semibold tracking-tight">
            ITR Intake
          </span>
          <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
            Prototype
          </span>
        </Link>
        <NavLinks />
      </div>
      <DemoBanner />
    </header>
  );
}

function DemoBanner() {
  return (
    <div className="border-t border-line bg-amber-wash">
      <p className="mx-auto max-w-6xl px-4 py-2 text-xs text-amber-ink sm:px-6">
        <strong className="font-semibold">Demo prototype.</strong> All names,
        references and figures shown are synthetic. ITR Intake does not
        calculate tax or file income tax returns.
      </p>
    </div>
  );
}
