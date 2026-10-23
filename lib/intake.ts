// Intake progress shapes and labels (mirrors lib/server/intake.ts). Computed
// by the server from stored data; the pages only display it.

export type IntakeStep = { key: "details" | "statement" | "documents"; done: boolean; outstanding?: number };
export type IntakeProgress = { steps: IntakeStep[]; complete: boolean; last_client_upload_at: string | null };

export const INTAKE_STEP_LABELS: Record<IntakeStep["key"], string> = {
  details: "Your details",
  statement: "Bank statement uploaded",
  documents: "Requested documents provided",
};

export const CA_INTAKE_STEP_LABELS: Record<IntakeStep["key"], string> = {
  details: "Client details",
  statement: "Usable bank statement",
  documents: "Required documents",
};

export function intakeSummary(p: IntakeProgress): string {
  if (p.complete) return "Complete";
  return `${p.steps.filter((s) => s.done).length} of ${p.steps.length} steps`;
}

export type ClientNextStep = { key: IntakeStep["key"] | "done" | "closed"; title: string; detail: string };

/**
 * What the client should do next on one intake, from the stored steps in order (details, a usable statement,
 * then requested documents). `uploadStatuses` are the case's statement upload outcomes, used only to explain
 * why a statement is still needed.
 */
export function clientNextStep(p: IntakeProgress, caseStatus: string, uploadStatuses: string[] = []): ClientNextStep {
  if (caseStatus === "closed") return { key: "closed", title: "This intake is closed", detail: "Your CA has closed it; nothing more is needed here." };
  const pending = p.steps.find((s) => !s.done);
  if (!pending) {
    return { key: "done", title: "You're up to date", detail: "Everything your CA has asked for so far is in. Your CA will be in touch." };
  }
  if (pending.key === "details") {
    return { key: "details", title: "Add your details", detail: "Your name and bank, so your CA can match your statement to you." };
  }
  if (pending.key === "statement") {
    const failed = uploadStatuses.some((s) => s === "rejected" || s === "processing_failed");
    return { key: "statement", title: "Upload your bank statement", detail: failed
      ? "Your earlier upload could not be used. Upload a text-based PDF from your bank, or a CSV."
      : "A PDF downloaded from your bank, or a CSV, for this financial year." };
  }
  const n = pending.outstanding ?? 0;
  return { key: "documents", title: n === 1 ? "Upload 1 required document" : `Upload ${n} required documents`,
    detail: "Your CA has asked for these. Upload each one under Documents your CA asked for." };
}
