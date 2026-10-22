"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { Button } from "@/components/ui/Button";

const ERRORS: Record<number, string> = {
  404: "This case has no prepared review yet.",
  429: "Too many workbook downloads for your firm. Try again later.",
  500: "The workbook could not be generated. Try again, or prepare the review again.",
};

// Downloads the internal workbook for the case's current review. The API
// checks the CA session and firm; the file is never cached (no-store).
export function WorkbookDownload({ reference, available, verified }: {
  reference: string;
  available: boolean;
  verified: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ca/cases/${encodeURIComponent(reference)}/workbook`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 401) {
        router.replace("/ca/login");
        return;
      }
      if (!res.ok) {
        setError(ERRORS[res.status] ?? "The workbook could not be downloaded. Please try again.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // The server names the file ([Bank]_[Name]_ITR_Summary_FY[YYYY-YY].xlsx).
      const named = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "");
      link.download = named?.[1] ?? `${reference}-ITR-Summary.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("The ITR Intake server is not reachable. Check that it is running and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button type="button" variant="secondary" onClick={download} disabled={!available || busy}>
        {busy ? "Preparing workbook…" : "Download internal workbook (.xlsx)"}
      </Button>
      {!available && <p className="text-xs text-ink-faint">Prepare a review first to download the workbook.</p>}
      {available && !verified && (
        <p className="text-xs text-amber-ink">The workbook is marked UNVERIFIED, like this review.</p>
      )}
      {available && <p className="text-xs text-ink-faint">Internal to your firm. Do not share it with the client.</p>}
      {error && <FormMessage tone="error">{error}</FormMessage>}
    </div>
  );
}
