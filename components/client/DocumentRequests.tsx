"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { FormMessage, primaryButton } from "@/components/ca/Field";
import { uploadFile } from "@/lib/api-client";
import {
  DOCUMENT_ACCEPT,
  documentError,
  MAX_DOCUMENT_BYTES,
  MAX_FILES_PER_REQUEST,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONES,
  type DocumentRequest,
} from "@/lib/document-requests";
import { formatBytes } from "@/lib/statements";

function Uploader({ reference, request }: { reference: string; request: DocumentRequest }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const full = request.files.length >= MAX_FILES_PER_REQUEST;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (progress !== null) return;
    const file = input.current?.files?.[0];
    setMessage(null);
    if (!file) {
      setMessage({ tone: "error", text: "Choose a PDF, JPEG or PNG file first." });
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      setMessage({ tone: "error", text: `The file is larger than ${formatBytes(MAX_DOCUMENT_BYTES)}.` });
      return;
    }
    setProgress(0);
    const result = await uploadFile(
      `/api/client/cases/${encodeURIComponent(reference)}/document-requests/${encodeURIComponent(request.id)}/files`,
      file,
      setProgress,
    );
    setProgress(null);
    if (input.current) input.current.value = "";
    if (result.status === 401) {
      router.replace("/client");
      router.refresh();
      return;
    }
    if (result.ok) {
      setMessage({
        tone: "info",
        text: result.data.created === false ? "This file was already uploaded for this request." : "Uploaded. Thank you.",
      });
      router.refresh();
      return;
    }
    setMessage({
      tone: "error",
      text: documentError(result.status, result.data.error, "The upload failed. Please try again."),
    });
    router.refresh(); // the request may have changed meanwhile (waived, limit reached)
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-2">
      <label htmlFor={`dr-${request.id}`} className="block text-sm font-medium">Upload a file</label>
      <input id={`dr-${request.id}`} ref={input} type="file" accept={DOCUMENT_ACCEPT}
             disabled={full || progress !== null}
             className="block w-full text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-white file:px-3 file:py-2 file:text-sm" />
      <p className="text-xs text-ink-faint">
        PDF, JPEG or PNG, up to {formatBytes(MAX_DOCUMENT_BYTES)} each. {request.files.length} of {MAX_FILES_PER_REQUEST} files uploaded.
      </p>
      {progress !== null && (
        <div role="status" className="space-y-1">
          <div className="h-2 overflow-hidden rounded-full bg-paper-deep">
            <div className="h-full bg-teal transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-xs text-ink-soft">Uploading… {Math.round(progress * 100)}%</p>
        </div>
      )}
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      {full && (
        <p className="text-xs text-ink-faint">The limit of {MAX_FILES_PER_REQUEST} files for this request has been reached.</p>
      )}
      <button type="submit" disabled={full || progress !== null} className={primaryButton}>
        {progress !== null ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}

// Requests from the client's CA for one case. The API returns only this
// client's own requests; no CA controls and no download links appear here.
export function DocumentRequests({ reference, requests, caseClosed }: {
  reference: string;
  requests: DocumentRequest[];
  caseClosed: boolean;
}) {
  if (requests.length === 0) return <p className="text-sm text-ink-soft">Your CA has not requested any documents.</p>;
  return (
    <ul className="space-y-3">
      {requests.map((r) => (
        <li key={r.id} className="rounded-xl border border-line p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">
              {r.label}{" "}
              <span className="text-xs font-normal text-ink-faint">{r.required ? "Required" : "Optional"}</span>
            </p>
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${REQUEST_STATUS_TONES[r.status]}`}>
              {REQUEST_STATUS_LABELS[r.status] ?? r.status}
            </span>
          </div>
          {r.description && <p className="mt-1 text-sm text-ink-soft">{r.description}</p>}
          {r.files.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-sm">
              {r.files.map((f, i) => (
                <li key={`${f.display_name}-${i}`} className="break-all">
                  {f.display_name} <span className="text-xs text-ink-faint">{formatBytes(f.size_bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          {r.status === "waived" ? (
            <p className="mt-2 text-sm text-ink-soft">Your CA has waived this request. No upload is needed.</p>
          ) : caseClosed ? (
            <p className="mt-2 text-sm text-ink-soft">This case is closed.</p>
          ) : (
            <>
              {r.status === "received" && (
                <p className="mt-2 text-sm text-teal-deep">Received. You can add more files if your CA asked for them.</p>
              )}
              <Uploader reference={reference} request={r} />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
