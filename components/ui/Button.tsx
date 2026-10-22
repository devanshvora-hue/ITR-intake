import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const BASE = "rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const SIZES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-sm",
};

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-strong",
  secondary: "border border-line bg-surface hover:border-ink-faint",
  danger: "border border-danger-fg/30 bg-surface text-danger-fg hover:bg-danger-bg",
};

/** Button classes, also for links styled as buttons. Never full width by itself. */
export function buttonClasses({ variant = "primary", size = "md" }: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  return `${BASE} ${SIZES[size]} ${VARIANTS[variant]}`;
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & {
  /** Required, so no button submits a form by accident. */
  type: "button" | "submit" | "reset";
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and marks it busy; the caller still sets the label (e.g. "Saving…"). */
  loading?: boolean;
};

export function Button({ variant, size, loading = false, disabled, className, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={className ? `${buttonClasses({ variant, size })} ${className}` : buttonClasses({ variant, size })}
    />
  );
}
