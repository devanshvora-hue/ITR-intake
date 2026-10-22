"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";

// Lets a signed-in client get a new resume code if they lost the first one.
export function ClientResumeCode() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function rotate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await postJson("/api/client/resume-code");
    setBusy(false);
    if (result.status === 401) {
      router.refresh();
      return;
    }
    if (result.ok && typeof result.data.resume_code === "string") setCode(result.data.resume_code);
    else setError(result.status === 429 ? "Too many attempts. Please try again later." : "A new code could not be made.");
  }

  return (
    <div className="text-sm">
      {code ? (
        <p>
          Your new resume code: <span className="font-mono text-base font-medium tracking-wider">{code}</span>
          <span className="block text-xs text-ink-faint">Write it down; the old code no longer works.</span>
        </p>
      ) : (
        <button type="button" onClick={rotate} disabled={busy} className="font-medium text-teal underline disabled:opacity-60">
          {busy ? "Making a code…" : "Lost your resume code? Get a new one"}
        </button>
      )}
      {error && <div className="mt-2"><FormMessage tone="error">{error}</FormMessage></div>}
    </div>
  );
}
