import { TONE_CLASSES, type Tone } from "@/lib/tones";

const SIZES = { sm: "px-2.5 py-0.5", md: "px-3 py-1" };

/** A status pill. The label is required: the colour only reinforces it. */
export function Badge({ tone, size = "sm", className, children }: {
  tone: Tone;
  size?: keyof typeof SIZES;
  className?: string;
  children: React.ReactNode;
}) {
  const classes = `rounded-full text-xs font-medium ${SIZES[size]} ${TONE_CLASSES[tone]}`;
  return <span className={className ? `${classes} ${className}` : classes}>{children}</span>;
}
