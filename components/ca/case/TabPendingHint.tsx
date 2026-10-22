"use client";

import { useLinkStatus } from "next/link";

// Rendered inside each case tab link. A section is a fresh server render of the
// whole case (several seconds on a slow connection), and there is deliberately
// no loading.tsx above the case route (it would turn the signed-out 307 into a
// streamed 200), so this is the click feedback: a pulsing bar along the tab's
// bottom edge while the section loads. It is always rendered and positioned
// absolutely, so it never changes the tab's width (the bar fits 375 px exactly).
export function TabPendingHint() {
  const { pending } = useLinkStatus();
  return (
    <>
      <span aria-hidden="true" data-pending={pending ? "true" : "false"}
            className={`pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent transition-opacity ${pending
              ? "opacity-100 motion-safe:animate-pulse" : "opacity-0"}`} />
      <span role="status" className="sr-only">{pending ? "Loading section…" : ""}</span>
    </>
  );
}
