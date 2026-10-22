"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormMessage, primaryButton } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";
import {
  documentError,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_TONES,
  type DocumentRequest,
  type RequestFile,
} from "@/lib/document-requests";
import { formatBytes } from "@/lib/statements";

const base = (reference: string) => `/api/ca/cases/${encodeURIComponent(reference)}`;

function CreateForm({ reference, caseClosed }: { reference: string; caseClosed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const description = String(data.get("description") ?? "").trim();
    setBusy(true);
    setMessage(null);
    const result = await postJson(`${base(reference)}/document-requests`, {
      label: String(data.get("label") ?? ""),
      ...(description ? { description } : {}),
      required: data.get("required") === "required",
    });
    setBusy(false);
    if (result.status === 401) {
      router.replace("/ca/login");
      return;
    }
    if (result.ok) {
      form.reset();
      setMessage({ tone: "info", text: "Request created. The client can now see it." });
      router.refresh();
      return;
    }
    const text =
      result.status === 400
        ? "Please check the label (2–120 characters) and explanation (up to 500)."
        : documentError(result.status, result.data.error, "The request could not be created. Please try again.");
    setMessage({ tone: "error", text });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-xl border border-line p-4">
      <h3 className="text-sm font-medium">Request a document</h3>
      <div>
        <label htmlFor="dr-label" className="block text-sm">Document</label>
        <input id="dr-label" name="label" required minLength={2} maxLength={120} disabled={caseClosed || busy}
               placeholder="e.g. Form 16 from employer"
               className="mt-1 w-full rounded-lg border border-control bg-surface px-3 py-2 text-sm focus:border-teal focus:outline-none" />
      </div>
      <div>
        <label htmlFor="dr-description" className="block text-sm">
          Explanation for the client <span className="text-ink-faint">(optional)</span>
        </label>
        <textarea id="dr-description" name="description" rows={2} maxLength={500} disabled={caseClosed || busy}
                  className="mt-1 w-full rounded-lg border border-control bg-surface px-3 py-2 text-sm focus:border-teal focus:outline-none" />
      </div>
      <fieldset className="flex gap-4 text-sm" disabled={caseClosed || busy}>
        <legend className="sr-only">Required or optional</legend>
        <label className="flex items-center gap-2"><input type="radio" name="required" value="required" defaultChecked /> Required</label>
        <label className="flex items-center gap-2"><input type="radio" name="required" value="optional" /> Optional</label>
      </fieldset>
      {message && <FormMessage tone={message.tone}>{message.text}</FormMessage>}
      <button type="submit" disabled={caseClosed || busy} className={primaryButton}>
        {busy ? "Creating…" : "Create request"}
      </button>
      {caseClosed && <p className="text-xs text-ink-faint">This case is closed; no new requests can be made.</p>}
    </form>
  );
}

function FileRow({ reference, file }: { reference: string; file: RequestFile }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (busy || !file.id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base(reference)}/documents/${encodeURIComponent(file.id)}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 401) {
        router.replace("/ca/login");
        return;
      }
      if (!res.ok) {
        setError(res.status === 429 ? "Too many downloads. Try again later." : "This file could not be downloaded.");
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = file.display_name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("The ITR Intake server is not reachable. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="break-all">
        {file.display_name}{" "}
        <span className="text-xs text-ink-faint">
          {formatBytes(file.size_bytes)} · {file.uploaded_at.slice(0, 16).replace("T", " ")} UTC
        </span>
      </span>
      <button type="button" onClick={download} disabled={busy || !file.id}
              className="rounded-lg border border-line bg-surface px-3 py-1 text-xs font-medium hover:border-ink-faint disabled:opacity-60">
        {busy ? "Downloading…" : "Download"}
      </button>
      {error && <span className="w-full text-xs text-rose-ink" role="alert">{error}</span>}
    </li>
  );
}

function RequestItem({ reference, request, caseClosed }: {
  reference: string;
  request: DocumentRequest;
  caseClosed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const waived = request.status === "waived";

  async function change(action: "waive" | "reopen") {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await postJson(`${base(reference)}/document-requests/${encodeURIComponent(request.id)}/${action}`);
    setBusy(false);
    if (result.status === 401) {
      router.replace("/ca/login");
      return;
    }
    if (result.ok) {
      setMessage({ tone: "info", text: action === "waive" ? "Request waived." : "Request reopened." });
      router.refresh();
      return;
    }
    setMessage({
      tone: "error",
      text: documentError(result.status, result.data.error, "The change could not be made. Please try again."),
    });
  }

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {request.label}{" "}
          <span className="text-xs font-normal text-ink-faint">{request.required ? "Required" : "Optional"}</span>
        </p>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${REQUEST_STATUS_TONES[request.status]}`}>
          {REQUEST_STATUS_LABELS[request.status] ?? request.status}
        </span>
      </div>
      {request.description && <p className="mt-1 text-sm text-ink-soft">{request.description}</p>}
      {request.files.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {request.files.map((f) => <FileRow key={f.id ?? f.display_name} reference={reference} file={f} />)}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-ink-faint">No files uploaded yet.</p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" disabled={busy || caseClosed} onClick={() => change(waived ? "reopen" : "waive")}
                className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium hover:border-ink-faint disabled:opacity-60">
          {busy ? "Saving…" : waived ? "Reopen request" : "Waive request"}
        </button>
        {!waived && request.files.length > 0 && (
          <span className="text-xs text-ink-faint">Uploaded files stay on record if you waive.</span>
        )}
      </div>
      {message && <div className="mt-2"><FormMessage tone={message.tone}>{message.text}</FormMessage></div>}
    </li>
  );
}

export function CaseDocumentRequests({ reference, requests, caseClosed }: {
  reference: string;
  requests: DocumentRequest[];
  caseClosed: boolean;
}) {
  const groups: [string, DocumentRequest[]][] = [
    ["Outstanding", requests.filter((r) => r.status === "requested")],
    ["Received", requests.filter((r) => r.status === "received")],
    ["Waived", requests.filter((r) => r.status === "waived")],
  ];
  return (
    <section aria-labelledby="doc-requests" className="mt-8 rounded-2xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="doc-requests" className="font-serif text-xl font-medium">Requested documents</h2>
        <p className="text-xs text-ink-soft">
          {groups.map(([label, items]) => `${items.length} ${label.toLowerCase()}`).join(" · ")}
        </p>
      </div>
      <div className="mt-4 grid gap-6 lg:grid-cols-[2fr_1fr]">
        {requests.length === 0 ? (
          <p className="text-sm text-ink-soft">
            No documents requested yet. Request one from the suggestions above or write your own.
          </p>
        ) : (
          <div className="space-y-5">
            {groups.filter(([, items]) => items.length).map(([label, items]) => (
              <div key={label}>
                <h3 className="text-xs font-medium uppercase tracking-wide text-ink-soft">{label} ({items.length})</h3>
                <ul className="mt-2 space-y-3">
                  {items.map((r) => (
                    <RequestItem key={r.id} reference={reference} request={r} caseClosed={caseClosed} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        <CreateForm reference={reference} caseClosed={caseClosed} />
      </div>
    </section>
  );
}
