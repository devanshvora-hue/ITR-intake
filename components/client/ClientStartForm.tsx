"use client";

import { useState } from "react";
import { DevEmailNotice } from "@/components/ca/DevEmailNotice";
import { Field, FormMessage, primaryButton } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";

type Done = { delivery: string; outboxUrl?: string };

// The server answers the same way whether or not the firm code is valid, so
// this form never says which part was wrong.
export function ClientStartForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await postJson("/api/client/start", {
      firm_code: String(form.get("firm_code") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
    });
    setBusy(false);
    if (result.status === 202) {
      setDone({ delivery: String(result.data.email_delivery), outboxUrl: result.data.dev_outbox_url as string | undefined });
      return;
    }
    setError(result.status === 0 ? "The ITR Intake server is not reachable. Please try again later." : "Please check your details and try again.");
  }

  if (done) {
    return (
      <div className="space-y-4">
        <FormMessage tone="info">
          If the firm code is correct, we have sent a link to your email address. Open it on this device to
          continue. The link works once and expires after 30 minutes.
        </FormMessage>
        {done.delivery === "simulated" && <DevEmailNotice outboxUrl={done.outboxUrl} />}
        {done.delivery === "not_configured" && (
          <FormMessage tone="error">Email delivery is not configured on this server, so no email was sent.</FormMessage>
        )}
        <p className="text-sm text-ink-soft">
          No email? Check the code with your CA and try again, or wait a few minutes before asking for a new link.
        </p>
        <button type="button" onClick={() => setDone(null)} className="text-sm font-medium text-teal underline">
          Start again
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="firm_code" label="Firm code" autoComplete="off" required maxLength={64}
             hint="Your CA gives you this code, for example 7K4P-92XM-QR3T." />
      <Field id="email" label="Your email" type="email" autoComplete="email" required maxLength={254} />
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? "Sending…" : "Email me a link"}
      </button>
    </form>
  );
}
