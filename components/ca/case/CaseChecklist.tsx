"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";
import {
  CA_STATUS_LABELS,
  checklistError,
  INCOME_SOURCES,
  LEVEL_LABELS,
  LEVEL_TONES,
  RESPONSE_LABELS,
  type CaChecklistItem,
  type ChecklistEvidence,
} from "@/lib/checklist";

const base = (reference: string) => `/api/ca/cases/${encodeURIComponent(reference)}/checklist`;
const smallButton =
  "rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium hover:border-ink-faint disabled:opacity-60";

function evidenceText(e: ChecklistEvidence): string {
  if (e.source === "profile") {
    return `Client declared: ${INCOME_SOURCES.find((s) => s.code === e.code)?.label ?? e.code}`;
  }
  if (e.source === "statement") return `Statement: ${e.rows} ${e.rows === 1 ? "row" : "rows"} classified as ${e.category}`;
  return "General suggestion";
}

function useAction(reference: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  async function run(path: string, body: unknown, success: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result = await postJson(`${base(reference)}${path}`, body);
    setBusy(false);
    if (result.status === 401) {
      router.replace("/ca/login");
      return;
    }
    if (result.ok) {
      setMessage({ tone: "info", text: success });
      router.refresh();
      return;
    }
    setMessage({ tone: "error", text: checklistError(result.status, result.data.error, "The change could not be made.") });
  }
  return { busy, message, run };
}

function Item({ reference, item, caseClosed }: { reference: string; item: CaChecklistItem; caseClosed: boolean }) {
  const { busy, message, run } = useAction(reference);
  const act = (action: "request" | "dismiss" | "restore", success: string) =>
    run(`/${encodeURIComponent(item.id)}`, { action }, success);
  const muted = item.status === "dismissed" || !item.applies;

  return (
    <li className={`rounded-xl border border-line p-4 ${muted ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{item.label}</p>
        <div className="flex gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${LEVEL_TONES[item.level]}`}>{LEVEL_LABELS[item.level]}</span>
          <span className="rounded-full bg-paper-deep px-3 py-1 text-xs font-medium">{CA_STATUS_LABELS[item.status]}</span>
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{item.reason}</p>
      <ul className="mt-2 space-y-0.5 text-xs text-ink-faint">
        {item.evidence.map((e, i) => <li key={i}>{evidenceText(e)}</li>)}
        {!item.applies && <li>The case data no longer triggers this suggestion.</li>}
      </ul>
      {item.response && (
        <p className="mt-2 rounded-lg bg-amber-wash px-3 py-2 text-sm text-amber-ink">
          Client: {RESPONSE_LABELS[item.response]}{item.note ? ` — “${item.note}”` : ""}
        </p>
      )}
      {!caseClosed && (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.status === "suggested" && item.applies && (
            <button type="button" className={smallButton} disabled={busy}
                    onClick={() => act("request", "Requested. The client now sees it under documents to upload.")}>
              {busy ? "Saving…" : "Request from client"}
            </button>
          )}
          {item.status === "suggested" && (
            <button type="button" className={smallButton} disabled={busy}
                    onClick={() => act("dismiss", "Dismissed. The client no longer sees this suggestion.")}>
              Dismiss
            </button>
          )}
          {item.status === "dismissed" && (
            <button type="button" className={smallButton} disabled={busy} onClick={() => act("restore", "Restored.")}>
              Restore
            </button>
          )}
        </div>
      )}
      {message && <div className="mt-2"><FormMessage tone={message.tone}>{message.text}</FormMessage></div>}
    </li>
  );
}

// Rules-based suggestions for the CA to review. Nothing reaches the client as
// a document request until the CA chooses "Request from client".
export function CaseChecklist({ reference, items, caseClosed }: {
  reference: string;
  items: CaChecklistItem[];
  caseClosed: boolean;
}) {
  const { busy, message, run } = useAction(reference);
  return (
    <section aria-labelledby="checklist" className="mt-8 rounded-2xl border border-line bg-surface p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="checklist" className="font-serif text-xl font-medium">Suggested documents</h2>
        {!caseClosed && (
          <button type="button" className={smallButton} disabled={busy}
                  onClick={() => run("", undefined, "Suggestions refreshed.")}>
            {busy ? "Refreshing…" : "Refresh suggestions"}
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-faint">
        Generated by fixed rules from the client&rsquo;s declared situations and high- or medium-confidence statement
        categories. An intake aid, not a tax determination: confirm relevance before requesting.
      </p>
      {message && <div className="mt-2"><FormMessage tone={message.tone}>{message.text}</FormMessage></div>}
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">No suggestions yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((item) => <Item key={item.id} reference={reference} item={item} caseClosed={caseClosed} />)}
        </ul>
      )}
    </section>
  );
}
