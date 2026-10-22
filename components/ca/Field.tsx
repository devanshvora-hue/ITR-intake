type FieldProps = {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  minLength?: number;
  maxLength?: number;
};

export function Field({ id, label, type = "text", autoComplete, required, hint, minLength, maxLength }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {!required && <span className="ml-1 font-normal text-ink-faint">(optional)</span>}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        className="mt-1.5 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm focus:border-teal focus:outline-none"
      />
      {hint && <p className="mt-1 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function FormMessage({ tone, children }: { tone: "error" | "info"; children: React.ReactNode }) {
  const cls = tone === "error" ? "bg-rose-wash text-rose-ink" : "bg-teal-wash text-teal-deep";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  );
}

export const primaryButton =
  "w-full rounded-lg bg-teal px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60";
