"use client";

import Link from "next/link";
import { Button } from "@/components/ui/Button";

// Unexpected failures while rendering a CA page. The shell stays in place (this
// boundary sits inside app/ca/layout.tsx). Pages still handle a signed-out
// visitor or an unreachable server themselves; this only catches what they
// did not expect. In production Next.js replaces server error messages with a
// digest, and only that reference is shown here, never the message.
export default function CaError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-teal">CA workspace</p>
      <h1 className="mt-3 text-3xl font-medium tracking-tight">This page could not be shown</h1>
      <p className="mt-3 text-sm text-ink-soft">
        Something went wrong while loading it. Try again; if it keeps happening, go back to the dashboard and open it
        from there.
      </p>
      {digest && (
        <p className="mt-3 text-xs text-ink-faint">
          Reference: <span className="font-mono">{digest}</span>
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={() => retry()}>Try again</Button>
        <Link href="/ca" className="text-sm font-medium text-teal underline">Back to dashboard</Link>
      </div>
    </div>
  );
}
