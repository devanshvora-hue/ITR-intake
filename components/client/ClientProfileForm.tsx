"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormMessage, primaryButton } from "@/components/ca/Field";
import { postJson } from "@/lib/api-client";
import { INCOME_SOURCES } from "@/lib/checklist";
import type { ClientProfile } from "@/lib/client-session";

const FIELD_ERRORS: Record<string, string> = {
  full_name: "Enter your full name (letters, spaces, . ' and - only).",
  bank_name: "Enter your bank's name.",
  account_last4: "Enter exactly the last 4 digits of the account, or leave it blank.",
  financial_year: "The financial year does not match this intake.",
  income_sources: "Please choose from the listed options only.",
};

const inputClass =
  "mt-1.5 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm focus:border-teal focus:outline-none";

// Collects only what statement processing and the document checklist need.
// Never asks for PAN, Aadhaar, full account numbers or passwords.
export function ClientProfileForm({ reference, financialYear, profile }: {
  reference: string;
  financialYear: string;
  profile: ClientProfile;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setErrors([]);
    setSaved(false);
    const form = new FormData(event.currentTarget);
    const last4 = String(form.get("account_last4") ?? "").trim();
    setBusy(true);
    const result = await postJson(`/api/client/cases/${encodeURIComponent(reference)}/profile`, {
      full_name: String(form.get("full_name") ?? ""),
      bank_name: String(form.get("bank_name") ?? ""),
      account_last4: last4 === "" ? null : last4,
      financial_year: financialYear,
      income_sources: form.getAll("income_sources").map(String),
    });
    setBusy(false);
    if (result.ok) {
      setSaved(true);
      router.refresh();
      return;
    }
    if (result.status === 401) {
      router.replace("/client");
      router.refresh();
      return;
    }
    if (result.status === 400 && Array.isArray(result.data.fields)) {
      setErrors((result.data.fields as string[]).map((f) => FIELD_ERRORS[f] ?? "Please check your details."));
    } else if (result.status === 429) setErrors(["Too many attempts. Please try again later."]);
    else if (result.status === 0) setErrors(["The ITR Intake server is not reachable. Please try again."]);
    else setErrors(["Your details could not be saved. Please try again."]);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor={`full_name-${reference}`} className="block text-sm font-medium">Full name</label>
        <input id={`full_name-${reference}`} name="full_name" autoComplete="name" required minLength={2} maxLength={100}
               defaultValue={profile.full_name ?? ""} className={inputClass} />
        <p className="mt-1 text-xs text-ink-faint">As it appears on your bank statement.</p>
      </div>
      <div>
        <label htmlFor={`bank_name-${reference}`} className="block text-sm font-medium">Bank name</label>
        <input id={`bank_name-${reference}`} name="bank_name" required minLength={2} maxLength={80}
               defaultValue={profile.bank_name ?? ""} className={inputClass} />
      </div>
      <div>
        <label htmlFor={`account_last4-${reference}`} className="block text-sm font-medium">
          Account number, last 4 digits <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        <input id={`account_last4-${reference}`} name="account_last4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4}
               autoComplete="off" defaultValue={profile.account_last4 ?? ""} className={`${inputClass} max-w-32`} />
        <p className="mt-1 text-xs text-ink-faint">Only the last 4 digits. Never enter your full account number.</p>
      </div>
      <fieldset>
        <legend className="block text-sm font-medium">
          In FY {financialYear}, did any of these apply to you? <span className="font-normal text-ink-faint">(optional)</span>
        </legend>
        <p className="mt-1 text-xs text-ink-faint">
          This only helps suggest which documents to gather. Leave everything unticked if you are not sure; your CA will ask.
        </p>
        <div className="mt-2 space-y-1.5">
          {INCOME_SOURCES.map((s) => (
            <label key={s.code} className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="income_sources" value={s.code} className="mt-0.5"
                     defaultChecked={profile.income_sources?.includes(s.code)} />
              {s.label}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-sm text-ink-soft">Financial year: <span className="font-medium text-ink">FY {financialYear}</span></p>
      {errors.map((e) => <FormMessage key={e} tone="error">{e}</FormMessage>)}
      {saved && <FormMessage tone="info">Your details are saved.</FormMessage>}
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? "Saving…" : profile.complete ? "Update details" : "Save details"}
      </button>
    </form>
  );
}
