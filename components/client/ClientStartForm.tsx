"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, FormMessage, primaryButton } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";

const ERRORS: Record<string, string> = {
  invalid_email: "Please enter a valid email address.",
  invalid_firm_code: "This firm code is not recognised. Please check it with your CA.",
  resume_code_invalid: "This resume code is not correct.",
  rate_limited: "Too many attempts. Please try again later.",
};

// Firm code + email signs the client straight in (no email link). A returning
// client on another browser also needs the resume code shown when they started.
export function ClientStartForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [newCode, setNewCode] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const form = new FormData(event.currentTarget);
    const resume = String(form.get("resume_code") ?? "").trim();
    setBusy(true);
    const result = await postJson("/api/client/start", {
      firm_code: String(form.get("firm_code") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      ...(resume ? { resume_code: resume } : {}),
    });
    setBusy(false);
    if (result.ok) {
      if (typeof result.data.resume_code === "string") setNewCode(result.data.resume_code);
      else router.refresh();
      return;
    }
    const code = String(result.data.error ?? "");
    if (code === "resume_code_required") {
      setNeedsCode(true);
      setError("This email already has an intake with this firm. Enter the resume code you were given to continue.");
      return;
    }
    setError(result.status === 0 ? "The ITR Intake server is not reachable. Please try again later."
      : ERRORS[code] ?? "Please check your details and try again.");
  }

  if (newCode) {
    return (
      <div className="space-y-4">
        <FormMessage tone="info">You&rsquo;re in. Your intake is saved as you go.</FormMessage>
        <div className="rounded-xl border border-accent/30 bg-accent-bg p-4">
          <p className="text-sm font-medium">Your resume code</p>
          <p className="mt-2 font-mono text-2xl tracking-wider">{newCode}</p>
          <p className="mt-2 text-sm text-ink-soft">
            Write it down. To continue later on another device or browser, you&rsquo;ll need your firm code, your email
            and this code. It is shown only now.
          </p>
        </div>
        <button type="button" className={primaryButton} onClick={() => router.refresh()}>Continue to my intake</button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="firm_code" label="Firm code" autoComplete="off" required maxLength={64}
             hint="Your CA gives you this code, for example 7K4P-92XM-QR3T." />
      <Field id="email" label="Your email" type="email" autoComplete="email" required maxLength={254} />
      {needsCode && (
        <Field id="resume_code" label="Resume code" autoComplete="off" required maxLength={64}
               hint="Shown when you first started, for example 4M2Q-X9KD-7PRT." />
      )}
      {error && <FormMessage tone="error">{error}</FormMessage>}
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? "Checking…" : needsCode ? "Continue my intake" : "Start or continue my intake"}
      </button>
    </form>
  );
}
