// Synthetic demo data for the stage 1 interface. Not derived from any real client.

export type IntakeStatus =
  | "Awaiting statement"
  | "Clarification in progress"
  | "Documents pending"
  | "Intake complete";

export type ReviewStatus = "Not started" | "In review" | "Queries raised" | "Reviewed";

export type DemoCase = {
  ref: string;
  clientLabel: string;
  financialYear: string;
  intakeStatus: IntakeStatus;
  pendingDocuments: number;
  reviewStatus: ReviewStatus;
  updated: string;
};

export const demoCases: DemoCase[] = [
  {
    ref: "DEMO-0142",
    clientLabel: "Demo Client A",
    financialYear: "FY 2025-26",
    intakeStatus: "Documents pending",
    pendingDocuments: 3,
    reviewStatus: "Not started",
    updated: "18 Oct 2026",
  },
  {
    ref: "DEMO-0139",
    clientLabel: "Demo Client B",
    financialYear: "FY 2025-26",
    intakeStatus: "Clarification in progress",
    pendingDocuments: 2,
    reviewStatus: "Not started",
    updated: "17 Oct 2026",
  },
  {
    ref: "DEMO-0137",
    clientLabel: "Demo Client C",
    financialYear: "FY 2025-26",
    intakeStatus: "Intake complete",
    pendingDocuments: 0,
    reviewStatus: "In review",
    updated: "16 Oct 2026",
  },
  {
    ref: "DEMO-0131",
    clientLabel: "Demo Client D",
    financialYear: "FY 2025-26",
    intakeStatus: "Intake complete",
    pendingDocuments: 0,
    reviewStatus: "Queries raised",
    updated: "14 Oct 2026",
  },
  {
    ref: "DEMO-0128",
    clientLabel: "Demo Client E",
    financialYear: "FY 2024-25",
    intakeStatus: "Awaiting statement",
    pendingDocuments: 4,
    reviewStatus: "Not started",
    updated: "12 Oct 2026",
  },
  {
    ref: "DEMO-0120",
    clientLabel: "Demo Client F",
    financialYear: "FY 2025-26",
    intakeStatus: "Intake complete",
    pendingDocuments: 0,
    reviewStatus: "Reviewed",
    updated: "9 Oct 2026",
  },
];
