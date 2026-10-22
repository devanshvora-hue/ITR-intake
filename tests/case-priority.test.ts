// Stage 4: the dashboard's priority queue (lib/case-priority.ts) and the
// dashboard that shows it. Synthetic cases only; the dashboard is
// server-rendered with the session lookup stubbed.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaCase, CaStatement, CaSessionState } from "@/lib/ca-session";
import { casePriority, priorityQueue, priorityReasons } from "@/lib/case-priority";
import type { CaseReadiness } from "@/lib/case-readiness";

const session: { value: CaSessionState } = { value: { state: "signed_out" } };
vi.mock("@/lib/ca-session", () => ({ getCaSession: async () => session.value }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/ca",
  useRouter: () => ({ refresh() {}, replace() {}, push() {} }),
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    React.createElement("a", { href, ...rest }, children as never) };
});

function readiness(over: Partial<CaseReadiness> & { required_outstanding?: number } = {}): CaseReadiness {
  const { required_outstanding = 0, ...rest } = over;
  return {
    statement: "verified", unverified_reasons: [], transactions_to_review: 0,
    documents: { required_outstanding, required_received: 0, required_waived: 0, optional_outstanding: 0,
      total_requests: required_outstanding },
    ...rest,
  };
}

function kase(reference: string, over: Partial<CaCase> = {}): CaCase {
  return {
    reference, financial_year: "2025-26", status: "ca_review_required", updated_at: "2026-10-20T10:00:00Z",
    created_at: "2026-10-01T10:00:00Z", client_first_name: `Client ${reference}`, client_email: `${reference}@example.test`,
    client_email_verified: true, profile: { full_name: null, bank_name: "Synthetic Bank", account_last4: null, complete: true },
    readiness: readiness(), intake: { steps: [{ key: "details", done: true }, { key: "statement", done: true },
      { key: "documents", done: true }], complete: true, last_client_upload_at: null },
    ...over,
  };
}

const incomplete = { steps: [{ key: "details" as const, done: false }, { key: "statement" as const, done: false },
  { key: "documents" as const, done: true }], complete: false, last_client_upload_at: null };

describe("casePriority", () => {
  it("puts blockers first: unverified statement, required documents outstanding, or only unusable uploads", () => {
    expect(casePriority(kase("A", { readiness: readiness({ statement: "unverified" }) }))).toBe(1);
    expect(casePriority(kase("B", { readiness: readiness({ required_outstanding: 2 }) }))).toBe(1);
    expect(casePriority(kase("C", { readiness: readiness({ statement: "none" }) }), ["rejected"])).toBe(1);
    expect(casePriority(kase("D", { readiness: readiness({ statement: "none" }) }), ["processing_failed", "rejected"])).toBe(1);
  });

  it("then decisions, then review preparation, then client actions, then ready", () => {
    expect(casePriority(kase("A", { readiness: readiness({ transactions_to_review: 3 }) }))).toBe(2);
    expect(casePriority(kase("B", { readiness: readiness({ statement: "not_prepared" }) }))).toBe(3);
    expect(casePriority(kase("C", { readiness: readiness({ statement: "none" }), intake: incomplete }))).toBe(4);
    expect(casePriority(kase("D", { readiness: readiness({ statement: "none" }) }), ["processing"])).toBe(4);
    expect(casePriority(kase("E", { intake: incomplete }))).toBe(4);
    expect(casePriority(kase("F"))).toBe(5);
  });

  it("ranks a blocker above pending decisions on the same case", () => {
    expect(casePriority(kase("A", { readiness: readiness({ statement: "unverified", transactions_to_review: 9 }) }))).toBe(1);
  });

  it("never queues a closed case, whatever its data says", () => {
    expect(casePriority(kase("A", { status: "closed", readiness: readiness({ statement: "unverified", required_outstanding: 3 }) })))
      .toBeNull();
  });
});

describe("priorityReasons", () => {
  it("names the facts behind the place, most pressing first", () => {
    expect(priorityReasons(kase("A", { readiness: readiness({ statement: "unverified", required_outstanding: 1,
      transactions_to_review: 2 }) }))).toEqual(["Statement review unverified", "1 required document outstanding",
      "2 transactions to decide"]);
    expect(priorityReasons(kase("B", { readiness: readiness({ statement: "none" }) }), ["rejected"]))
      .toEqual(["Uploaded statement could not be used"]);
    expect(priorityReasons(kase("C", { readiness: readiness({ statement: "none" }), intake: incomplete })))
      .toEqual(["No usable statement yet", "Client details incomplete"]);
    expect(priorityReasons(kase("D"))).toEqual([]);
  });
});

describe("priorityQueue", () => {
  const cases = [
    kase("READY", { updated_at: "2026-10-01T00:00:00Z" }),
    kase("DECIDE-FEW", { readiness: readiness({ transactions_to_review: 1 }) }),
    kase("DECIDE-MANY", { readiness: readiness({ transactions_to_review: 7 }) }),
    kase("BLOCK-DOCS-1", { readiness: readiness({ required_outstanding: 1 }), updated_at: "2026-10-05T00:00:00Z" }),
    kase("BLOCK-DOCS-3", { readiness: readiness({ required_outstanding: 3 }) }),
    kase("BLOCK-UNVERIFIED-OLD", { readiness: readiness({ statement: "unverified" }), updated_at: "2026-09-01T00:00:00Z" }),
    kase("BLOCK-UNVERIFIED-NEW", { readiness: readiness({ statement: "unverified" }), updated_at: "2026-10-21T00:00:00Z" }),
    kase("PREPARE", { readiness: readiness({ statement: "not_prepared" }) }),
    kase("WAIT", { readiness: readiness({ statement: "none" }), intake: incomplete }),
    kase("UNUSABLE", { readiness: readiness({ statement: "none" }), updated_at: "2026-10-22T00:00:00Z" }),
    kase("CLOSED", { status: "closed", readiness: readiness({ statement: "unverified" }) }),
    kase("TIE-B", { readiness: readiness({ statement: "not_prepared" }) }),
    kase("TIE-A", { readiness: readiness({ statement: "not_prepared" }) }),
  ];
  const uploads = [{ case_reference: "UNUSABLE", status: "rejected" }, { case_reference: "WAIT", status: "processing" }];
  const expected = [
    "BLOCK-DOCS-3", // most required documents outstanding
    "BLOCK-DOCS-1",
    "BLOCK-UNVERIFIED-OLD", // then the case untouched longest
    "BLOCK-UNVERIFIED-NEW",
    "UNUSABLE",
    "DECIDE-MANY", // more transactions to decide first
    "DECIDE-FEW",
    "PREPARE", // same priority and update time: by reference
    "TIE-A",
    "TIE-B",
    "WAIT",
    "READY",
  ];

  it("orders by priority, then documents, then decisions, then oldest update, then reference", () => {
    expect(priorityQueue(cases, uploads).map((e) => e.case.reference)).toEqual(expected);
  });

  it("is deterministic whatever order the cases arrive in", () => {
    for (const shuffled of [[...cases].reverse(), [...cases.slice(6), ...cases.slice(0, 6)]]) {
      expect(priorityQueue(shuffled, uploads).map((e) => e.case.reference)).toEqual(expected);
    }
  });

  it("leaves closed cases out and carries each entry's priority and reasons", () => {
    const queue = priorityQueue(cases, uploads);
    expect(queue.find((e) => e.case.reference === "CLOSED")).toBeUndefined();
    expect(queue[0]).toMatchObject({ priority: 1, reasons: ["3 required documents outstanding"] });
    expect(queue.at(-1)).toMatchObject({ priority: 5, reasons: [] });
  });
});

describe("dashboard", () => {
  const firmCode = { active: { code: "SYNTH", display: "SYN1-TEST-CODE", status: "active" as const,
    created_at: "2026-10-01T00:00:00Z", revoked_at: null }, previous: [], can_manage: true };
  const me = { user: { full_name: "Test CA", email: "ca@example.test", role: "owner" }, firm: { name: "Synthetic & Co" },
    session: { idle_expires_at: "", absolute_expires_at: "" } };
  const statement = (case_reference: string, status: CaStatement["status"]): CaStatement => ({
    id: `s-${case_reference}`, file_type: "csv", display_name: "s.csv", size_bytes: 10, status, error_code: null,
    reasons: [], page_warnings: [], rejected_rows: [], duplicate_rows: [], pages_total: null, rows_extracted: 0,
    rows_rejected: 0, rows_duplicate: 0, rows_summary: 0, period_start: null, period_end: null,
    uploaded_at: "2026-10-01T00:00:00Z", case_reference, client_first_name: "X", financial_year: "2025-26", bank_name: null,
  });

  beforeEach(() => {
    session.value = {
      state: "signed_in", me: { ...me, firm: { ...me.firm, status: "active" } }, firmCode,
      cases: [kase("IT-READY"), kase("IT-BLOCKED", { readiness: readiness({ statement: "unverified" }) }),
        kase("IT-CLOSED", { status: "closed" })],
      statements: [statement("IT-READY", "extracted")],
    };
  });

  it("shows the queue first, blockers on top, and keeps the counters, firm code, full table and uploads", async () => {
    const { default: Dashboard } = await import("@/app/ca/page");
    const markup = renderToStaticMarkup(await Dashboard());
    const queue = markup.slice(markup.indexOf('id="queue"'), markup.indexOf('id="cases"'));
    expect(queue.indexOf("IT-BLOCKED")).toBeGreaterThan(-1);
    expect(queue.indexOf("IT-BLOCKED")).toBeLessThan(queue.indexOf("IT-READY"));
    expect(queue).not.toContain("IT-CLOSED");
    expect(queue).toContain(">Blocked <");
    expect(queue).toContain(">Ready for the workbook <");
    expect(queue).toContain("Statement review unverified");
    expect(queue).toContain("Check the unverified statement");
    // Everything the dashboard showed before is still there.
    for (const label of ["Cases", "Open", "Need CA review", "Need attention"]) expect(markup).toContain(`>${label}</p>`);
    expect(markup).toContain('aria-label="Active firm code">SYN1-TEST-CODE</p>');
    const table = markup.slice(markup.indexOf('id="cases"'));
    for (const ref of ["IT-READY", "IT-BLOCKED", "IT-CLOSED"]) expect(table).toContain(`>${ref}</a>`);
    expect(markup).toContain(">Statement uploads</h2>");
    expect(markup).toContain("Signed in as <span");
  });

  it("explains an empty queue", async () => {
    session.value = { ...session.value, cases: [kase("IT-CLOSED", { status: "closed" })], statements: [] } as CaSessionState;
    const { default: Dashboard } = await import("@/app/ca/page");
    expect(renderToStaticMarkup(await Dashboard())).toContain("No open cases. Closed cases are listed under Client cases.");
  });

  it("still sends a signed-out visitor to sign in", async () => {
    session.value = { state: "signed_out" };
    const { default: Dashboard } = await import("@/app/ca/page");
    await expect(Dashboard()).rejects.toThrow("NEXT_REDIRECT /ca/login");
  });
});
