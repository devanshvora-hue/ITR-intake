import { TONE_CLASSES } from "@/lib/tones";

// Errors are announced at once (role="alert"); other messages politely (role="status").
const TONES = { error: TONE_CLASSES.danger, success: TONE_CLASSES.success, info: TONE_CLASSES.accent };

export function FormMessage({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-lg px-3 py-2 text-sm ${TONES[tone]}`}>
      {children}
    </p>
  );
}
