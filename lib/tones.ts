// Semantic tones for status badges and messages. Status maps elsewhere in lib/
// choose a tone per status; the colours behind each tone are tokens in
// app/globals.css, so a theme can change them without touching any status map.

export type Tone = "success" | "warning" | "danger" | "neutral" | "muted" | "accent";

export const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-success-bg text-success-fg",
  warning: "bg-warning-bg text-warning-fg",
  danger: "bg-danger-bg text-danger-fg",
  neutral: "bg-neutral-bg text-neutral-fg",
  muted: "bg-neutral-bg text-muted-fg",
  accent: "bg-accent-bg text-accent-fg",
};

/** The badge classes for every key of a status-to-tone map. */
export function toneClasses<K extends string>(tones: Record<K, Tone>): Record<K, string> {
  return Object.fromEntries(Object.entries<Tone>(tones).map(([key, tone]) => [key, TONE_CLASSES[tone]])) as Record<K, string>;
}
