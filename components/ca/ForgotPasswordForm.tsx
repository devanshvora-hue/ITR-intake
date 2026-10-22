"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { postJson } from "@/lib/api-client";
import { DevEmailNotice } from "./DevEmailNotice";
import { Field, FormMessage } from "./Field";

type Done = { delivery: string; outboxUrl?: string };

// The server answers the same way whether or not the address has an account,
// so this page never says whether one exists.
export function ForgotPasswordForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await postJson("/api/ca/request-password-reset", { email: String(form.get("email") ?? "").trim() });
    setBusy(false);
    if (result.status === 202) {
      setDone({ delivery: String(result.data.email_delivery), outboxUrl: result.data.dev_outbox_url as string | undefined });
      return;
    }
    setError(result.status === 0 ? "The server could not be reached. Check your connection and try again." : "Please check the email address and try again.");
  }

  if (done) {
    return (
      <div className="space-y-4">
        <FormMessage tone="info">
          If an account exists for that address, a password reset link is on its way. The link works once and
          expires after 30 minutes.
        </FormMessage>
        {done.delivery === "simulated" && <DevEmailNotice outboxUrl={done.outboxUrl} />}
        {done.delivery === "not_configured" && (
          <FormMessage tone="error">
            Email delivery is not configured on this server, so no reset email was sent.
          </FormMessage>
        )}
      </div>
    );
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-5">
      <Field id="email" label="Email" type="email" autoComplete="username" required maxLength={254} />
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <Button type="submit" size="lg" loading={busy} className="w-full">
        {busy ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
