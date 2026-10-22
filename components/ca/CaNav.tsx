"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";

// The destinations the site already had; "Dashboard" is the CA dashboard.
export const CA_NAV_LINKS = [
  { href: "/ca", label: "Dashboard" },
  { href: "/client", label: "Client portal" },
  { href: "/", label: "Overview" },
] as const;

/** Dashboard is current on the dashboard and on case pages, not on the sign-in pages under /ca. */
export function isCurrent(href: string, pathname: string): boolean {
  if (href === "/ca") return pathname === "/ca" || pathname.startsWith("/ca/cases/");
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function linkClass(current: boolean) {
  return `rounded-md px-3 py-1.5 text-sm transition-colors ${current
    ? "bg-accent-bg font-medium text-ink" : "text-ink-soft hover:bg-paper-deep hover:text-ink"}`;
}

// Inline links from the sm breakpoint; below it, a disclosure menu so every
// destination stays reachable at 375 px.
export function CaNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuId = useId();

  // Close the menu on Escape (choosing a link closes it too).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const links = CA_NAV_LINKS.map(({ href, label }) => {
    const current = isCurrent(href, pathname);
    return (
      <Link key={href} href={href} aria-current={current ? "page" : undefined} className={linkClass(current)}
            onClick={() => setOpen(false)}>
        {label}
      </Link>
    );
  });

  return (
    <nav aria-label="Main" className="ml-auto">
      <div className="hidden items-center gap-1 sm:flex">{links}</div>
      <div className="sm:hidden">
        <button type="button" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm text-ink">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            {open
              ? <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              : <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
          </svg>
          Menu
        </button>
        <div id={menuId} hidden={!open}
             className="absolute inset-x-0 top-full border-b border-line bg-surface px-4 py-3">
          <div className="flex flex-col gap-1">{links}</div>
        </div>
      </div>
    </nav>
  );
}
