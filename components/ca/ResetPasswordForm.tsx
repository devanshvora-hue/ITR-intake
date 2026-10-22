"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, buttonClasses } from "@/components/ui/Button";
import { postJson } from "@/lib/api-client";
import { Field, FormMessage } from "./Field";

const nextStep = `${buttonClasses({ size: "lg" })} block w-full text-center`;

const PASSWORD_MESSAGES: Record<string, string> = {
  password_too_short: "Use at least 12 characters for your password.",
  password_too_long: "That password is too long.",
  password_too_common: "That password is too common or simple. Choose something less predictable.",
};

type Phase = "form" | "done" | "missing";

// The token is carried in the URL fragment (#token=...), which browsers never
// send to a server. It is moved into memory and removed from the address bar
// as soon as the page loads; it is never written to browser storage.
export function ResetPasswordForm() {
  const token = useRef<string | null>(null);
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // React may run this effect twice in development; the second run would
    // find the fragment already removed and wrongly report a missing token.
    if (started.current) return;
    started.current = true;
    token.current = new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(null, "", window.location.pathname);
    if (!token.current) setPhase("missing");
  }, []);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("new_password") ?? "");
    if (password !== String(form.get("confirm_password") ?? "")) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    const result = await postJson("/api/ca/reset-password", { token: token.current, new_password: password });
    setBusy(false);
    if (result.ok) {
      token.current = null;
      setPhase("done");
      return;
    }
    if (result.status === 0) setError("The server could not be reached. Check your connection and try again.");
    else if (result.status === 429) setError("Too many attempts. Please try again later.");
    else if (result.data.error === "invalid_password")
      setError(PASSWORD_MESSAGES[String(result.data.code)] ?? "Please choose a stronger password.");
    else setError("This reset link is invalid or has expired. Request a new one from the sign-in page.");
  }

  if (phase === "missing")
    return (
      <div className="space-y-4">
        <FormMessage tone="error">This reset link is missing its code. Request a new link.</FormMessage>
        <Link href="/ca/forgot-password" className={nextStep}>
          Request a new reset link
        </Link>
      </div>
    );

  if (phase === "done")
    return (
      <div className="space-y-4">
        <FormMessage tone="success">Your password has been changed and you have been signed out everywhere.</FormMessage>
        <Link href="/ca/login" className={nextStep}>
          Go to sign in
        </Link>
      </div>
    );

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-5">
      <Field id="new_password" label="New password" type="password" autoComplete="new-password" required
             minLength={12} maxLength={256} hint="At least 12 characters." />
      <Field id="confirm_password" label="Confirm new password" type="password" autoComplete="new-password" required
             minLength={12} maxLength={256} />
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <Button type="submit" size="lg" loading={busy} className="w-full">
        {busy ? "Saving…" : "Set new password"}
      </Button>
    </form>
  );
}
