"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormMessage } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";
import {
  checklistError,
  LEVEL_LABELS,
  LEVEL_TONES,
  MAX_RESPONSE_NOTE,
  RESPONSE_LABELS,
  type ClientChecklistItem,
  type ClientResponse,
} from "@/lib/checklist";

const smallButton =
  "rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-medium hover:border-ink-faint disabled:opacity-60";

function Item({ reference, item, caseClosed }: { reference: string; item: ClientChecklistItem; caseClosed: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState<ClientResponse | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function send(response: ClientResponse | null, text: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await postJson(
      `/api/client/cases/${encodeURIComponent(reference)}/checklist/${encodeURIComponent(item.id)}`,
      { response, ...(response && text.trim() ? { note: text.trim() } : {}) },
    );
    setBusy(false);
    if (result.status === 401) {
      router.replace("/client");
      router.refresh();
      return;
    }
    if (result.ok) {
      setChoosing(null);
      setNote("");
      router.refresh();
      return;
    }
    setError(result.status === 400
      ? `Please keep the note under ${MAX_RESPONSE_NOTE} characters.`
      : checklistError(result.status, result.data.error, "Your answer could not be saved. Please try again."));
  }

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{item.label}</p>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${LEVEL_TONES[item.level]}`}>
          {LEVEL_LABELS[item.level]}
        </span>
      </div>
      <p className="mt-1 text-sm text-ink-soft">{item.reason}</p>
      {item.response ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink">
            You said: <span className="font-medium">{RESPONSE_LABELS[item.response]}</span>
            {item.note && <span className="text-ink-soft"> — {item.note}</span>}
          </span>
          {!caseClosed && (
            <button type="button" className={smallButton} disabled={busy} onClick={() => send(null, "")}>
              {busy ? "Saving…" : "Change answer"}
            </button>
          )}
        </div>
      ) : choosing ? (
        <div className="mt-3 space-y-2">
          <label htmlFor={`note-${item.id}`} className="block text-sm">
            {RESPONSE_LABELS[choosing]}. Anything your CA should know? <span className="text-ink-faint">(optional)</span>
          </label>
          <textarea id={`note-${item.id}`} rows={2} maxLength={MAX_RESPONSE_NOTE} value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="w-full rounded-lg border border-line bg-white px-3 py-2 text-sm focus:border-teal focus:outline-none" />
          <div className="flex gap-2">
            <button type="button" className={smallButton} disabled={busy} onClick={() => send(choosing, note)}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className={smallButton} disabled={busy} onClick={() => setChoosing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        !caseClosed && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={smallButton} onClick={() => setChoosing("unavailable")}>
              {RESPONSE_LABELS.unavailable}
            </button>
            <button type="button" className={smallButton} onClick={() => setChoosing("not_applicable")}>
              {RESPONSE_LABELS.not_applicable}
            </button>
          </div>
        )
      )}
      {error && <div className="mt-2"><FormMessage tone="error">{error}</FormMessage></div>}
    </li>
  );
}

// Suggestions only: nothing here is uploaded or sent to the CA as a request.
// When the CA asks for one of these, it moves to "Documents your CA asked for".
export function ClientChecklist({ reference, items, caseClosed }: {
  reference: string;
  items: ClientChecklistItem[];
  caseClosed: boolean;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-ink-soft">No suggestions yet. They appear as you add your details and your CA reviews your statement.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-faint">
        A starting list based on what you told us and your bank statement. It is not tax advice: your CA decides what is
        needed and will ask for documents here. You can start gathering these now, or tell your CA if one doesn&rsquo;t apply.
      </p>
      <ul className="space-y-3">
        {items.map((item) => <Item key={item.id} reference={reference} item={item} caseClosed={caseClosed} />)}
      </ul>
    </div>
  );
}
