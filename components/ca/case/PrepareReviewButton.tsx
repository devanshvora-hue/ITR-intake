"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { Button } from "@/components/ui/Button";
import { postJson } from "@/lib/api-client";
import { PREPARE_ERRORS } from "@/lib/case-review";

// Asks the API to (re)build the case's review from one stored statement. The
// server decides the firm from the session; this only names the statement.
export function PrepareReviewButton({ reference, statementId, replacesReview, isCurrent }: {
  reference: string;
  statementId: string;
  replacesReview: boolean;
  isCurrent: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConfirming(false);
    const result = await postJson(`/api/ca/cases/${encodeURIComponent(reference)}/review`, { statement_id: statementId });
    setBusy(false);
    if (result.ok) {
      router.refresh();
      return;
    }
    if (result.status === 401) {
      router.replace("/ca/login");
      return;
    }
    if (result.status === 0) {
      setError({ message: "The ITR Intake server is not reachable. Check that it is running and try again.", retry: true });
      return;
    }
    const code = typeof result.data.error === "string" ? result.data.error : "";
    setError(PREPARE_ERRORS[code] ?? { message: "The review could not be prepared. Please try again.", retry: true });
  }

  const label = isCurrent ? "Prepare again" : replacesReview ? "Use this statement" : "Prepare review";
  return (
    <div className="space-y-2">
      {confirming ? (
        <div className="space-y-2 rounded-lg border border-line bg-paper px-3 py-2 text-xs">
          <p>This replaces the current review with one built from this statement.</p>
          <div className="flex gap-2">
            <Button type="button" onClick={run} disabled={busy}>Replace review</Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant={isCurrent ? "secondary" : "primary"} disabled={busy}
                onClick={() => (replacesReview && !isCurrent ? setConfirming(true) : run())}>
          {busy ? "Preparing…" : label}
        </Button>
      )}
      {busy && <p className="text-xs text-ink-soft" role="status">Reading and classifying the statement…</p>}
      {error && (
        <div className="space-y-2">
          <FormMessage tone="error">{error.message}</FormMessage>
          {error.retry && (
            <Button type="button" variant="secondary" onClick={run} disabled={busy}>Try again</Button>
          )}
        </div>
      )}
    </div>
  );
}
