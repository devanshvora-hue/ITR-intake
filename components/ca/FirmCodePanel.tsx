"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
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
          ? "No answer came back from the server. Reload the page to see whether the change was made."
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
    <section aria-labelledby="firm-code" className="rounded-2xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h2 id="firm-code" className="text-lg font-semibold tracking-tight">Firm code</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft">
          Clients enter this code to find your firm when they start an intake. It identifies your firm; it is
          not a password.
        </p>
      </div>

      <div className="space-y-5 px-5 py-5">
        {active ? (
          <div className="rounded-xl border border-line bg-paper p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium uppercase tracking-wide text-teal">Active code</p>
              <Button type="button" size="sm" onClick={copy} variant="secondary">
                {copied ? "Copied" : "Copy code"}
              </Button>
            </div>
            <p className="mt-2 break-all font-mono text-2xl font-medium tracking-[0.12em]" aria-label="Active firm code">
              {active.display}
            </p>
            <p className="mt-1 text-xs text-ink-faint">Active since {day(active.created_at)}</p>
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
                    <Button type="button" disabled={busy} onClick={() => setConfirm("rotate")} variant="secondary">
                      Rotate code
                    </Button>
                    <Button type="button" disabled={busy} onClick={() => setConfirm("revoke")} variant="danger">
                      Revoke code
                    </Button>
                  </>
                ) : (
                  <Button type="button" disabled={busy} onClick={() => run("/api/ca/firm-code")} variant="primary">
                    {busy ? "Generating…" : "Generate firm code"}
                  </Button>
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
                  <Button type="button" disabled={busy} onClick={() => run("/api/ca/firm-code/rotate")} variant="primary">
                    {busy ? "Rotating…" : "Rotate now"}
                  </Button>
                  <Button type="button" disabled={busy} onClick={() => setConfirm(null)} variant="secondary">
                    Cancel
                  </Button>
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
                  <Button type="button" disabled={busy} onClick={() => run("/api/ca/firm-code/revoke")} variant="danger">
                    {busy ? "Revoking…" : "Revoke now"}
                  </Button>
                  <Button type="button" disabled={busy} onClick={() => setConfirm(null)} variant="secondary">
                    Cancel
                  </Button>
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
                <li key={p.code} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
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
