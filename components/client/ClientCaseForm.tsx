"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, FormMessage, primaryButton } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";

// Opens (or returns) the signed-in client's case for a financial year. The
// server decides the client and firm from the session cookie.
export function ClientCaseForm({ years }: { years: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await postJson("/api/client/cases", {
      first_name: String(form.get("first_name") ?? "").trim(),
      financial_year: String(form.get("financial_year") ?? ""),
    });
    setBusy(false);
    if (result.ok) {
      if (result.status === 200) setNotice("You already have an open intake for that year; it is listed above.");
      router.refresh();
      return;
    }
    if (result.status === 401) {
      router.replace("/client");
      router.refresh();
      return;
    }
    if (result.status === 409) setError("This firm code is no longer active. Please ask your CA for their current code.");
    else if (result.status === 429) setError("Too many attempts. Please try again later.");
    else if (result.status === 0) setError("The ITR Intake server is not reachable. Please try again later.");
    else setError("Please enter your first name and choose a financial year.");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field id="first_name" label="First name" autoComplete="given-name" required maxLength={100} />
      <div>
        <label htmlFor="financial_year" className="block text-sm font-medium">
          Financial year
        </label>
        <select
          id="financial_year"
          name="financial_year"
          required
          defaultValue={years[1] ?? years[0]}
          className="mt-1.5 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm focus:border-teal focus:outline-none"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              FY {y}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-ink-faint">April to March. Choose the year your return is for.</p>
      </div>
      {error && <FormMessage tone="error">{error}</FormMessage>}
      {notice && <FormMessage tone="info">{notice}</FormMessage>}
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? "Starting…" : "Start my intake"}
      </button>
    </form>
  );
}
