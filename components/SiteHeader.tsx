import Link from "next/link";
import { BrandLockup } from "./BrandMark";
import { NavLinks } from "./NavLinks";

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-md">
          <BrandLockup />
          <span className="hidden rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint sm:inline">
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
    <div className="border-t border-line bg-paper">
      <p className="mx-auto max-w-6xl px-4 py-1.5 text-xs text-ink-soft sm:px-6">
        <strong className="font-semibold text-warning-fg">Demo prototype.</strong> All names, references and figures
        shown are synthetic. ITR Intake does not calculate tax or file income tax returns.
      </p>
    </div>
  );
}
