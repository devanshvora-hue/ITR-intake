"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { postJson } from "@/lib/api-client";
import type { FirmCodeState } from "@/lib/ca-session";
import { FormMessage } from "./Field";

type Confirm = "rotate" | "revoke" | null;

const ERRORS: Record<number, string> = {
  401: "Your session has ended. Please sign in again.",
  403: "Only the firm owner can change the firm code.",
  409: "Your firm has no active code to revoke.",
  429: "Too many firm code changes. Please try again later.",
};

const buttonBase =
  "rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const primary = `${buttonBase} bg-teal text-white hover:bg-teal-deep`;
const secondary = `${buttonBase} border border-line bg-white hover:border-ink-faint`;
const danger = `${buttonBase} border border-rose-ink/30 bg-white text-rose-ink hover:bg-rose-wash`;

function day(stamp: string | null) {
  return stamp ? stamp.slice(0, 10) : "";
}

// Shows the signed-in firm's code. Every change goes to the API (which decides
// the firm from the session) and the page is then re-rendered from the server.
export function FirmCodePanel({ initial }: { initial: FirmCodeState }) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, startTransition] = useTransition();
  const { active, previous, can_manage: canManage } = initial;

  async function run(path: string) {
    setBusy(true);
    setError(null);
    setCopied(false);
    const result = await postJson(path);
    setBusy(false);
    setConfirm(null);
    if (!result.ok) {
      if (result.status === 401) {
        router.replace("/ca/login");
        return;
      }
      setError(
        result.status === 0
          ? "The ITR Intake server is not reachable. Is it running?"
          : (ERRORS[result.status]
            ?? `The firm code could not be changed. Please try again. (Reference: ${
              typeof result.data.ref === "string" ? result.data.ref : `${result.status} ${String(result.data.error ?? "")}`})`),
      );
    }
    startTransition(() => router.refresh());
  }

  async function copy() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.display);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="firm-code" className="mt-10 rounded-2xl border border-line bg-white">
      <div className="border-b border-line px-5 py-4">
        <h2 id="firm-code" className="font-serif text-lg font-medium">Firm code</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Clients enter this code to find your firm when they start an intake. It identifies your firm; it is
          not a password.
        </p>
      </div>

      <div className="space-y-5 px-5 py-5">
        {active ? (
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-teal">Active code</p>
              <p className="mt-1 font-mono text-2xl font-medium tracking-[0.12em]" aria-label="Active firm code">
                {active.display}
              </p>
              <p className="mt-1 text-xs text-ink-faint">Active since {day(active.created_at)}</p>
            </div>
            <button type="button" onClick={copy} className={secondary}>
              {copied ? "Copied" : "Copy code"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-ink-soft">
            Your firm has no active code, so new clients cannot find your firm yet.
          </p>
        )}

        {canManage ? (
          <div className="space-y-3">
            {confirm === null && (
              <div className="flex flex-wrap gap-3">
                {active ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => setConfirm("rotate")} className={secondary}>
                      Rotate code
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirm("revoke")} className={danger}>
                      Revoke code
                    </button>
                  </>
                ) : (
                  <button type="button" disabled={busy} onClick={() => run("/api/ca/firm-code")} className={primary}>
                    {busy ? "Generating…" : "Generate firm code"}
                  </button>
                )}
              </div>
            )}
            {confirm === "rotate" && (
              <div className="rounded-xl border border-line bg-paper px-4 py-3 text-sm">
                <p>
                  Rotating creates a new code and stops <strong className="font-medium">{active?.display}</strong>{" "}
                  from working <strong className="font-medium">immediately</strong> (there is no grace period).
                  Existing cases are not affected.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button type="button" disabled={busy} onClick={() => run("/api/ca/firm-code/rotate")} className={primary}>
                    {busy ? "Rotating…" : "Rotate now"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirm(null)} className={secondary}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {confirm === "revoke" && (
              <div className="rounded-xl border border-rose-ink/20 bg-rose-wash px-4 py-3 text-sm text-rose-ink">
                <p>
                  Revoking stops new clients from using <strong className="font-medium">{active?.display}</strong>{" "}
                  immediately, and your firm will have no active code until you generate a new one. Existing cases are
                  not affected.
                </p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button type="button" disabled={busy} onClick={() => run("/api/ca/firm-code/revoke")} className={danger}>
                    {busy ? "Revoking…" : "Revoke now"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirm(null)} className={secondary}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-faint">Only the firm owner can generate, rotate or revoke the code.</p>
        )}

        {error && <FormMessage tone="error">{error}</FormMessage>}

        {previous.length > 0 && (
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-ink-faint">Earlier codes</h3>
            <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
              {previous.map((p) => (
                <li key={p.code} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="font-mono text-ink-faint line-through">{p.display}</span>
                  <span className="text-xs text-ink-faint">Revoked {day(p.revoked_at)} · no longer accepted</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
