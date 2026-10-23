// Stage 6: the transaction review workspace. The rules (lib/review-workspace.ts)
// are tested directly; the component is server-rendered for its initial
// state and for each state of the detail panel. The full page with a real
// review from the routes is in case-page-render.test.ts. Synthetic rows only.

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewWorkspace, TransactionDetail } from "@/components/ca/case/ReviewWorkspace";
import type { CaseReview, ReviewRow } from "@/lib/case-review";
import {
  defaultFilter, filterCounts, isDirty, moveSelection, saveDecision, savedValues, selectionAfterSave, visibleRows,
} from "@/lib/review-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, replace() {}, push() {} }) }));

function row(n: number, over: Partial<ReviewRow> = {}): ReviewRow {
  return {
    row_number: n, is_valid: true, issues: [], date: `2025-04-${String(n).padStart(2, "0")}`, narration: `SYNTHETIC ROW ${n}`,
    debit: "100.00", credit: null, balance: "1000.00", category: "Personal Expenses", confidence: "high", review_status: null,
    flags: [], classification_reason: "Matched a merchant rule. More detail follows here.", source_page: null, mode: "UPI",
    counterparty: `PAYEE ${n}`, group: "auto", classifier_category: "Personal Expenses", decision: null, stale_decision: null,
    ...over,
  };
}

const rows: ReviewRow[] = [
  row(1),
  row(2, { group: "confirm", category: "Salary / Pension", classifier_category: "Salary / Pension", confidence: "medium",
    credit: "85000.00", debit: null, narration: "NEFT SALARY SYNTHETIC LTD", counterparty: "SYNTHETIC LTD" }),
  row(3, { group: "manual", category: "Others – Needs Review", classifier_category: "Others – Needs Review", confidence: "low" }),
  row(4, { group: "reviewed", category: "Rent Paid", classifier_category: "Personal Expenses", confidence: null,
    decision: { decision: "changed", note: "Landlord confirmed", decided_at: "2026-10-01T00:00:00Z" } }),
  row(5, { group: "rejected", is_valid: false, issues: ["date_invalid"], category: null, classifier_category: null,
    source_page: 2 }),
  row(6, { group: "confirm", category: "Rent Received", classifier_category: "Rent Received",
    stale_decision: { category: "Gifts / Receipts from Non-relatives", decided_at: "2026-09-01T00:00:00Z" } }),
];

function review(list: ReviewRow[] = rows): CaseReview {
  const count = (g: ReviewRow["group"]) => list.filter((r) => r.group === g).length;
  return { totals: { rows: list.length, valid: list.length - count("rejected"), rejected: count("rejected"), auto: count("auto"),
    confirm: count("confirm"), manual: count("manual"), reviewed: count("reviewed"), stale_decisions: 0, credits: "0", debits: "0" },
    rows: list } as unknown as CaseReview;
}

const html = (node: ReactNode) => renderToStaticMarkup(node as Parameters<typeof renderToStaticMarkup>[0]);
const noop = () => {};
const detail = (r: ReviewRow | null, over: Record<string, unknown> = {}) => html(createElement(TransactionDetail, {
  row: r, inList: true, draft: r ? savedValues(r) : null, dirty: false, busy: false, caseClosed: false,
  onEdit: noop, onSave: noop, onUndo: noop, onDiscard: noop, onShowAll: noop, ...over }));

describe("filters and search (unchanged semantics)", () => {
  it("shows the review queue by default when anything waits, otherwise everything", () => {
    expect(defaultFilter(review())).toBe("needs");
    expect(defaultFilter(review([row(1), row(4, { group: "reviewed" })]))).toBe("all");
    expect(filterCounts(review())).toEqual({ all: 6, needs: 3, auto: 1, reviewed: 1, rejected: 1 });
  });

  it("filters by group and searches narration, payee and category, case-insensitively, in the review's order", () => {
    expect(visibleRows(rows, "needs", "").map((r) => r.row_number)).toEqual([2, 3, 6]);
    expect(visibleRows(rows, "rejected", "").map((r) => r.row_number)).toEqual([5]);
    expect(visibleRows(rows, "all", "  salary ").map((r) => r.row_number)).toEqual([2]);
    expect(visibleRows(rows, "all", "payee 4").map((r) => r.row_number)).toEqual([4]);
    expect(visibleRows(rows, "all", "rent").map((r) => r.row_number)).toEqual([4, 6]);
    expect(visibleRows(rows, "needs", "nothing like this")).toEqual([]);
  });
});

describe("selection", () => {
  const shown = visibleRows(rows, "needs", ""); // 2, 3, 6

  it("moves with the arrow keys, Home and End, without wrapping", () => {
    expect(moveSelection(shown, 2, "ArrowDown")).toBe(3);
    expect(moveSelection(shown, 6, "ArrowDown")).toBe(6);
    expect(moveSelection(shown, 2, "ArrowUp")).toBe(2);
    expect(moveSelection(shown, 3, "Home")).toBe(2);
    expect(moveSelection(shown, 2, "End")).toBe(6);
    expect(moveSelection(shown, 4, "ArrowDown")).toBe(2); // a selection outside the list starts at the top
    expect(moveSelection(shown, 2, "a")).toBeUndefined();
    expect(moveSelection([], null, "ArrowDown")).toBeUndefined();
  });

  it("moves on to the next transaction after a save, else the previous, else stays", () => {
    expect(selectionAfterSave(shown, 2)).toBe(3);
    expect(selectionAfterSave(shown, 6)).toBe(3);
    expect(selectionAfterSave([rows[1]], 2)).toBe(2);
    expect(selectionAfterSave(shown, 4)).toBe(4); // not in the list: keep it
  });

  it("treats only a real change as unsaved", () => {
    const reviewed = rows[3];
    expect(savedValues(reviewed)).toEqual({ category: "Rent Paid", note: "Landlord confirmed" });
    expect(isDirty(reviewed, undefined)).toBe(false);
    expect(isDirty(reviewed, { category: "Rent Paid", note: " Landlord confirmed " })).toBe(false);
    expect(isDirty(reviewed, { category: "Personal Expenses", note: "Landlord confirmed" })).toBe(true);
    expect(isDirty(reviewed, { category: "Rent Paid", note: "" })).toBe(true);
  });
});

describe("saveDecision", () => {
  afterEach(() => vi.unstubAllGlobals());
  function stub(status: number, body: unknown = {}) {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("posts the category with the trimmed note, as before", async () => {
    const fetch = stub(200, { row: null });
    expect(await saveDecision("IT A", 7, "Rent Paid", "  landlord  ")).toEqual({ kind: "saved" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/ca/cases/IT%20A/review/rows/7");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-ITR-Request")).toBe("1");
    expect(JSON.parse(String(init.body))).toEqual({ category: "Rent Paid", note: "landlord" });
  });

  it("undoes with a null category and no note, and drops a blank note", async () => {
    const fetch = stub(200);
    await saveDecision("IT-A", 7, null, "ignored");
    await saveDecision("IT-A", 7, "Rent Paid", "   ");
    expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ category: null });
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toEqual({ category: "Rent Paid" });
  });

  it("keeps the old outcomes for a lost session, server messages and no connection", async () => {
    stub(401);
    expect(await saveDecision("IT-A", 7, "Rent Paid", "")).toEqual({ kind: "signed_out" });
    stub(409, { message: "This case is closed." });
    expect(await saveDecision("IT-A", 7, "Rent Paid", "")).toEqual({ kind: "error", message: "This case is closed." });
    stub(500);
    expect(await saveDecision("IT-A", 7, "Rent Paid", "")).toEqual({ kind: "error", message: "The change could not be saved." });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await saveDecision("IT-A", 7, "Rent Paid", "")).toEqual({ kind: "error", message: "The server is not reachable. Try again." });
  });
});

describe("workspace", () => {
  it("opens on the review queue with the first row selected and shown in the detail panel", () => {
    const markup = html(createElement(ReviewWorkspace, { reference: "IT-A", review: review(), caseClosed: false }));
    expect(markup).toMatch(/aria-selected="true"[^>]*>Needs review <span[^>]*>3<\/span>/);
    expect(markup).toContain('role="listbox" aria-label="Transactions" tabindex="0"');
    expect(markup).toContain('aria-activedescendant="txn-2"');
    expect(markup.match(/role="option"/g)).toHaveLength(3);
    expect(markup).toMatch(/<li id="txn-2" role="option" aria-selected="true"/);
    expect(markup).toMatch(/<li id="txn-3" role="option" aria-selected="false"/);
    expect(markup).toContain(">Transaction #2</h3>");
    expect(markup).toContain(">Confirm category<"); // the status label and, with the category unchanged, the button
    expect(markup).toContain(">Classify manually<");
    expect(markup).toContain("₹85,000.00");
    expect(markup).not.toContain("SYNTHETIC ROW 1"); // auto-classified: not in the queue
    expect(markup).toContain('<p class="sr-only" role="status">3 transactions shown</p>');
  });

  it("starts phones on the list, with the detail as a separate view, and shows both side by side from lg", () => {
    const markup = html(createElement(ReviewWorkspace, { reference: "IT-A", review: review(), caseClosed: false }));
    expect(markup).toMatch(/<div class="block overflow-hidden rounded-2xl border border-line bg-surface lg:block">/);
    expect(markup).toMatch(/<section aria-labelledby="txn-detail" class="hidden [^"]*lg:block/);
    expect(markup).toMatch(/<button type="button" class="mb-3 text-sm font-medium text-teal underline lg:hidden">← Back to list<\/button>/);
    expect(markup).toContain("lg:grid-cols-[minmax(0,1fr)_24rem]");
  });

  it("explains an empty list and an empty selection", () => {
    const markup = html(createElement(ReviewWorkspace, { reference: "IT-A", review: review([]), caseClosed: false }));
    expect(markup).toContain("No transactions match.");
    expect(markup).not.toContain('role="listbox"');
    expect(markup).toContain("Select a transaction to see its details and decide its category.");
  });
});

describe("transaction detail", () => {
  it("shows every fact the review has for the row, the full reason and its confidence", () => {
    const markup = detail(rows[1]);
    for (const text of ["2025-04-02", "CSV row", "NEFT SALARY SYNTHETIC LTD", "UPI", "SYNTHETIC LTD", "₹85,000.00", "₹1,000.00",
      "Salary / Pension", "medium confidence", "Matched a merchant rule. More detail follows here."]) {
      expect(markup).toContain(text);
    }
    expect(markup).toMatch(/<select id="txn-category"[^>]*>/);
    expect(markup.match(/<option /g)).toHaveLength(28);
    expect(markup).toMatch(/<input id="txn-note" maxLength="300"/);
    expect(markup).toMatch(/<button type="button"[^>]*>Confirm category<\/button>/);
    expect(markup).not.toContain("Undo my decision");
    expect(markup).not.toContain("Discard changes");
  });

  it("shows the CA's decision, what the rules said, and Undo", () => {
    const markup = detail(rows[3]);
    expect(markup).toContain(">Reviewed by CA<");
    expect(markup).toContain("Rules said: Personal Expenses");
    expect(markup).toContain("CA note: Landlord confirmed");
    expect(markup).toMatch(/>Undo my decision<\/button>/);
    expect(markup).toMatch(/>Save category<\/button>/); // the category in force differs from the rules'
    expect(markup).not.toContain("confidence");
  });

  it("warns about a stale decision", () => {
    expect(detail(rows[5])).toContain("Your earlier decision (Gifts / Receipts from Non-relatives) no longer matches this row");
  });

  it("explains a row that could not be read and offers no decision", () => {
    const markup = detail(rows[4]);
    expect(markup).toContain("Not read from the statement (page 2): ");
    expect(markup).toContain(">Not read<");
    expect(markup).not.toContain("txn-category");
    expect(markup).not.toContain("Debit");
  });

  it("locks decisions on a closed case", () => {
    const markup = detail(rows[1], { caseClosed: true });
    expect(markup).toContain("The case is closed; categories can no longer be changed.");
    expect(markup).not.toContain("txn-category");
  });

  it("keeps unsaved changes visible and lets the CA discard them", () => {
    const markup = detail(rows[1], { draft: { category: "Rent Received", note: "check" }, dirty: true });
    expect(markup).toMatch(/<option value="Rent Received" selected="">/);
    expect(markup).toContain('value="check"');
    expect(markup).toMatch(/>Save category<\/button>/);
    expect(markup).toMatch(/>Discard changes<\/button>/);
    expect(markup).toContain("Unsaved changes. They stay here if you look at other transactions.");
  });

  it("disables every control while a decision is being saved", () => {
    const markup = detail(rows[3], { busy: true });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toMatch(/<button type="button" disabled="" aria-busy="true"[^>]*>Saving…<\/button>/);
    expect(markup).toMatch(/<button type="button" disabled=""[^>]*>Undo my decision<\/button>/);
    expect(markup).toMatch(/<select id="txn-category" disabled=""/);
    expect(markup).toMatch(/<input id="txn-note" maxLength="300" disabled=""/);
  });

  it("says when the selected row is hidden by the filter or search", () => {
    const markup = detail(rows[0], { inList: false });
    expect(markup).toContain("Not in the list for the current filter or search.");
    expect(markup).toMatch(/>Show all transactions<\/button>/);
  });
});
