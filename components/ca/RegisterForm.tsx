"use client";

import Link from "next/link";
import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Field, FormMessage } from "./Field";

const PASSWORD_MESSAGES: Record<string, string> = {
  password_too_short: "Use at least 12 characters for your password.",
  password_too_long: "That password is too long.",
  password_too_common: "That password is too common or simple. Choose something less predictable.",
  email_invalid: "Enter a valid email address.",
  email_taken: "An account with this email address already exists. Sign in instead.",
  registration_number_taken: "A firm with this registration number is already registered.",
};

const legend = "mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint";

export function RegisterForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const value = (name: string) => {
      const v = String(form.get(name) ?? "").trim();
      return v === "" ? null : v;
    };
    setBusy(true);
    const result = await postJson("/api/ca/register", {
      full_name: value("full_name"),
      email: value("email"),
      password: String(form.get("password") ?? ""),
      firm_name: value("firm_name"),
      contact_phone: value("contact_phone"),
      contact_address: value("contact_address"),
      registration_number: value("registration_number"),
    });
    setBusy(false);
    if (result.status === 201) {
      setDone(true);
      return;
    }
    if (result.status === 0) setError("The server could not be reached. Check your connection and try again.");
    else if (result.status === 429) setError("Too many registrations from here. Please try again later.");
    else if (typeof result.data.code === "string" && PASSWORD_MESSAGES[result.data.code])
      setError(PASSWORD_MESSAGES[result.data.code]);
    else setError("Please check your details and try again.");
  }

  if (done) {
    return (
      <div className="space-y-5">
        <FormMessage tone="success">
          Your firm is registered. Your account is ready. You can now access your CA dashboard.
        </FormMessage>
        <Link href="/ca" className={`${buttonClasses({ size: "lg" })} block w-full text-center`}>
          Continue to dashboard
        </Link>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-7" noValidate={false}>
      <fieldset className="space-y-4">
        <legend className={legend}>Your account</legend>
        <Field id="full_name" label="Full name" autoComplete="name" required maxLength={200} />
        <Field id="email" label="Professional email" type="email" autoComplete="email" required maxLength={254} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" required minLength={12}
               maxLength={256} hint="At least 12 characters." />
      </fieldset>
      <hr className="border-line" />
      <fieldset className="space-y-4">
        <legend className={legend}>Your firm</legend>
        <Field id="firm_name" label="Firm name" autoComplete="organization" required maxLength={200} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="contact_phone" label="Contact phone" type="tel" autoComplete="tel" maxLength={40} />
          <Field id="registration_number" label="Registration number" maxLength={64}
                 hint="Firm or membership number. Self-declared; recorded with your firm, not verified automatically." />
        </div>
        <Field id="contact_address" label="Contact address" autoComplete="street-address" maxLength={500} />
      </fieldset>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <Button type="submit" size="lg" loading={busy} className="w-full">
        {busy ? "Creating account…" : "Create account"}
      </Button>
    </form>
  );
}
