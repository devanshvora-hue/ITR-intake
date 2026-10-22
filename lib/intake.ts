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
