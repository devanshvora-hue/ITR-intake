"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Field, FormMessage, primaryButton } from "./Field";

export function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await postJson("/api/ca/login", {
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
    });
    if (result.ok) {
      router.replace("/ca");
      router.refresh();
      return;
    }
    setBusy(false);
    setError(result.status === 0 ? "The ITR Intake server is not reachable. Is it running?" : "Invalid email or password.");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="email" label="Email" type="email" autoComplete="username" required maxLength={254} />
      <Field id="password" label="Password" type="password" autoComplete="current-password" required maxLength={256} />
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
