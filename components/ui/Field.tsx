type FieldProps = {
  id: string;
  label: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
  /** Shown under the input and linked to it, which also marks the input invalid. */
  error?: string;
  minLength?: number;
  maxLength?: number;
};

// A labelled text input. The hint and any error are tied to the input with
// aria-describedby so screen readers read them with the field.
export function Field({ id, label, type = "text", autoComplete, required, hint, error, minLength, maxLength }: FieldProps) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
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
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className="mt-1.5 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm focus:border-teal focus:outline-none"
      />
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-ink-faint">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-danger-fg">{error}</p>}
    </div>
  );
}
