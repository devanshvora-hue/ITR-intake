import Link from "next/link";
import { BrandLockup } from "@/components/BrandMark";
import { CaNav } from "./CaNav";

// The dark CA workspace frame: full-width top bar, the demo notice, the page
// and a footer. Pages keep their own content containers, so wide tables keep
// the width they need.
export function CaShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-ca flex flex-1 flex-col bg-paper text-ink">
      <header className="sticky top-0 z-40 border-b border-line bg-paper/90 backdrop-blur">
        <div className="relative flex h-14 items-center gap-4 px-4 sm:px-6 lg:px-8">
          <Link href="/ca" className="flex items-center gap-2.5 rounded-md">
            <BrandLockup />
            <span className="hidden rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-faint sm:inline">
              Prototype
            </span>
          </Link>
          <CaNav />
        </div>
      </header>
      <p className="border-b border-line bg-surface px-4 py-1.5 text-xs text-ink-soft sm:px-6 lg:px-8">
        <strong className="font-semibold text-warning-fg">Demo prototype.</strong> All names, references and figures
        shown are synthetic. ITR Intake does not calculate tax or file income tax returns.
      </p>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-line">
        <div className="flex flex-col gap-1 px-4 py-5 text-xs text-ink-faint sm:flex-row sm:justify-between sm:px-6 lg:px-8">
          <p>ITR Intake prototype for CA firms.</p>
          <p>Not a tax computation or filing tool. Demo data only.</p>
        </div>
      </footer>
    </div>
  );
}
