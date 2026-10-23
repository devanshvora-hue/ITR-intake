import Link from "next/link";
import { BrandLockup } from "./BrandMark";

const COLUMNS = [
  { title: "CA firms", links: [{ href: "/ca/register", label: "Register your firm" }, { href: "/ca/login", label: "Sign in" },
    { href: "/ca", label: "CA dashboard" }] },
  { title: "Clients", links: [{ href: "/client", label: "Client portal" }] },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-[minmax(0,1.5fr)_repeat(2,minmax(0,1fr))] sm:px-6">
        <div>
          <BrandLockup />
          <p className="mt-3 max-w-sm text-sm text-ink-soft">
            Client intake and bank-statement review for CA firms. Not a tax computation or filing tool.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <nav key={col.title} aria-label={`${col.title} links`}>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{col.title}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {col.links.map((l) => (
                <li key={l.href}><Link href={l.href} className="text-ink-soft hover:text-ink hover:underline">{l.label}</Link></li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-6xl px-4 py-4 text-xs text-ink-faint sm:px-6">
          ITR Intake prototype. Demo data only: all names, references and figures shown are synthetic.
        </p>
      </div>
    </footer>
  );
}
