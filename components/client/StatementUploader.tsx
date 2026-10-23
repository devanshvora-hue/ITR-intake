"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FormMessage, primaryButton } from "@/components/ca/Field";
import { uploadFile } from "@/lib/api-client";
import type { UploadLimits } from "@/lib/client-session";
import { describe, formatBytes, type StatementUpload } from "@/lib/statements";

// Uploads one PDF or CSV and then shows the server's actual result. It never
// claims success for an upload that was rejected or needs review.
export function StatementUploader({ reference, limits, disabled }: {
  reference: string;
  limits: UploadLimits;
  disabled: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (progress !== null) return; // already uploading
    const file = input.current?.files?.[0];
    setMessage(null);
    if (!file) {
      setMessage({ tone: "error", text: "Choose a PDF or CSV file first." });
      return;
    }
    const lower = file.name.toLowerCase();
    const limit = lower.endsWith(".csv") ? limits.csv_bytes : limits.pdf_bytes;
    if (!lower.endsWith(".pdf") && !lower.endsWith(".csv")) {
      setMessage({ tone: "error", text: "Only PDF and CSV files are accepted." });
      return;
    }
    if (file.size > limit) {
      setMessage({ tone: "error", text: `The file is larger than ${formatBytes(limit)}.` });
      return;
    }
    setProgress(0);
    const result = await uploadFile(`/api/client/cases/${encodeURIComponent(reference)}/statements`, file, setProgress);
    setProgress(null);
    if (input.current) input.current.value = "";
    const statement = result.data.statement as StatementUpload | undefined;
    if (result.status === 401) {
      router.replace("/client");
      router.refresh();
      return;
    }
    if (statement) {
      if (statement.status === "extracted") {
        const n = statement.rows_extracted;
        setMessage({ tone: "info", text: `Read ${n} transaction${n === 1 ? "" : "s"}. All checks passed.` });
      } else if (statement.status === "manual_review_required") {
        const n = statement.rows_extracted;
        setMessage({ tone: "info", text: `Uploaded. ${n} transaction${n === 1 ? " was" : "s were"} read, but the statement needs a manual check by your CA (details below).` });
      } else if (statement.status === "rejected") {
        setMessage({ tone: "error", text: `Not accepted: ${describe(statement.error_code ?? "")}` });
      } else {
        setMessage({ tone: "error", text: "Uploaded, but it could not be processed. Your CA can see it." });
      }
      if (result.status === 200 && result.data.created === false) {
        setMessage({ tone: "info", text: "This file was already uploaded; its result is shown below." });
      }
      router.refresh();
      return;
    }
    const errors: Record<number, string> = {
      0: "The upload did not reach the server. Check your connection and try again.",
      409: String(result.data.message ?? "This file cannot be uploaded now."),
      413: "The file is too large.",
      429: "Too many uploads. Please try again later.",
    };
    setMessage({ tone: "error", text: errors[result.status] ?? "The upload failed. Please try again." });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <label htmlFor={`file-${reference}`} className="block text-sm font-medium">Choose your statement (PDF or CSV)</label>
      <div className={`rounded-xl border-2 border-dashed px-4 py-5 transition-colors ${disabled
        ? "border-line bg-paper-deep" : "border-control bg-paper hover:border-accent"}`}>
        <input
          id={`file-${reference}`}
          ref={input}
          type="file"
          accept=".pdf,.csv,application/pdf,text/csv"
          disabled={disabled || progress !== null}
          className="block w-full cursor-pointer text-sm text-ink-soft file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-accent file:px-4 file:py-3 file:text-sm file:font-medium file:text-on-accent hover:file:bg-accent-strong disabled:cursor-not-allowed disabled:file:opacity-60"
        />
      </div>
      <p className="text-xs text-ink-faint">
        PDF up to {formatBytes(limits.pdf_bytes)} and {limits.pdf_pages} pages (a text-based statement downloaded from
        your bank, not a scan or photo, and not password-protected), or CSV up to {formatBytes(limits.csv_bytes)} in
        UTF-8 with Date, Narration and Debit/Credit columns. At most {limits.statements_per_case} statements per intake.
      </p>
      {progress !== null && (
        <div className="space-y-1" role="status">
          <div className="h-2 overflow-hidden rounded-full bg-paper-deep">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-xs text-ink-soft">
            {progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : "Reading the statement…"}
          </p>
        </div>
      )}
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      <button type="submit" disabled={disabled || progress !== null} className={primaryButton}>
        {progress !== null ? "Uploading…" : "Upload statement"}
      </button>
      {disabled && <p className="text-xs text-ink-faint">Save your details above before uploading.</p>}
    </form>
  );
}
