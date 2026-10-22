"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { postJson } from "@/lib/api-client";
import { authLink } from "./AuthCard";
import { Field, FormMessage } from "./Field";

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
    setError(result.status === 0 ? "The server could not be reached. Check your connection and try again." : "Invalid email or password.");
  }

  return (
    <form method="post" onSubmit={onSubmit} className="space-y-5">
      <Field id="email" label="Email" type="email" autoComplete="username" required maxLength={254} />
      <div className="space-y-2">
        <Field id="password" label="Password" type="password" autoComplete="current-password" required maxLength={256} />
        <p className="text-right text-xs">
          <Link href="/ca/forgot-password" className={authLink}>Forgot password?</Link>
        </p>
      </div>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <Button type="submit" size="lg" loading={busy} className="w-full">
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
