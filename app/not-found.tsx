import type { Metadata } from "next";
import Link from "next/link";
import { SiteChrome } from "@/components/SiteChrome";

export const metadata: Metadata = { title: "Page not found · ITR Intake" };

// Any address that matches no page. Shown in the light site frame, with the
// three places a visitor can start from.
export default function NotFound() {
  return (
    <SiteChrome>
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">404</p>
        <h1 className="mt-3 font-serif text-3xl font-medium tracking-tight">Page not found</h1>
        <p className="mt-3 text-sm text-ink-soft">There is no page at this address. It may have moved, or the link may be mistyped.</p>
        <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm font-medium">
          <li><Link href="/ca" className="text-teal underline">CA dashboard</Link></li>
          <li><Link href="/client" className="text-teal underline">Client portal</Link></li>
          <li><Link href="/" className="text-teal underline">Overview</Link></li>
        </ul>
      </div>
    </SiteChrome>
  );
}
