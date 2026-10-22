// Extraction accuracy on realistic table-style statements: column mapping by
// true position, Indian number formats, stated and carried-forward balances,
// duplicates, missing rows, ambiguous rows and the running-balance cross-check.
// Synthetic statements only, read through the real pdf.js extraction.

import { describe, expect, it } from "vitest";
import { EXTRACTED, MANUAL_REVIEW, parseCsv, parsePdfPages, type ImportResult } from "@/lib/statement/import";
import { extractPdfPages } from "@/lib/statement/pdf-text";
import { verification } from "@/lib/server/readiness";
import { tableStatement, type TableOptions, type TableRow } from "./helpers/synthetic-pdf";

const FY = "2025-26";

/** Indian grouping: 12345678.90 -> "1,23,45,678.90". */
function inr(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = (abs / 100n).toString();
  const last3 = whole.slice(-3), rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}${grouped}.${String(abs % 100n).padStart(2, "0")}`;
}

type Spec = [narration: string, ref: string, amount: bigint, side: "d" | "c"];
const SPECS: Spec[] = [
  ["UPI/P2M/512345678901/SYNTHETIC GROCER/UTIB/Payment", "UPI512345678901", 45650n, "d"],
  ["NEFT-SYNTH0012345-ACME SYNTHETIC PVT LTD-SALARY APR", "N09234567812", 12500000n, "c"],
  ["ACH/SYNTH HOME LOAN EMI/0000123456789", "ACH00012345", 3245000n, "d"],
  ["ATM CASH WDL 01234 SYNTH BRANCH", "ATM0001234", 2000000n, "d"],
  ["IMPS/P2A/512398765432/SYNTH TENANT/Rent", "IMPS51239876", 2500000n, "c"],
  ["LIC PREMIUM SYNTH POLICY 912345678", "CHQ000145", 2415000n, "d"],
  ["INT.PD:01-01-2025 TO 31-03-2025", "", 135075n, "c"],
  ["BY CASH DEPOSIT SYNTH BRANCH", "CSH000981", 15000000n, "c"],
  ["SMS ALERT CHARGES INCL GST", "", 1770n, "d"],
  ["NEFT-SYNTH998877-CAMS MF REDEMPTION", "N09998877", 123456789n, "c"],
];
const OPENING = 12543050n;

/** Rows over `pageCount` pages with a correct running balance, plus the expected (debit, credit) per row. */
function statement(pageCount = 3, opening = OPENING, narration = (n: string) => n) {
  let balance = opening;
  const rows: TableRow[] = [];
  const expected: [string | null, string | null][] = [];
  for (let month = 0; month < pageCount; month++) {
    SPECS.forEach(([text, ref, amount, side], i) => {
      balance += side === "c" ? amount : -amount;
      const date = `${String(i * 2 + 1).padStart(2, "0")}/${String(4 + month).padStart(2, "0")}/2025`;
      rows.push({ date, narration: narration(text), ref, balance: inr(balance), [side === "c" ? "credit" : "debit"]: inr(amount) });
      expected.push(side === "c" ? [null, inr(amount)] : [inr(amount), null]);
    });
  }
  const per = Math.ceil(rows.length / pageCount);
  const pages = Array.from({ length: pageCount }, (_, p) => rows.slice(p * per, (p + 1) * per));
  return { pages, expected, closing: inr(balance), rows };
}

async function read(pdf: Uint8Array): Promise<ImportResult> {
  return parsePdfPages(await extractPdfPages(pdf), FY);
}

const amounts = (r: ImportResult) => r.transactions.map((t) => [t.debit, t.credit]);

describe("debit/credit column mapping", () => {
  const layouts: [string, TableOptions][] = [
    ["proportional font, left-aligned labels", { headerAlign: "left" }],
    ["proportional font, centred labels, reference column", { headerAlign: "centre", refColumn: true }],
    ["proportional font, right-aligned labels", { headerAlign: "right" }],
    ["monospaced font, centred labels", { font: "courier", headerAlign: "centre", refColumn: true }],
  ];
  for (const [name, opts] of layouts) {
    it(`reads every amount in its own column: ${name}`, async () => {
      const s = statement();
      const r = await read(tableStatement(s.pages, opts));
      expect([r.status, r.rejected, r.reviewReasons]).toEqual([EXTRACTED, [], []]);
      expect(amounts(r)).toEqual(s.expected);
      expect(r.transactions.map((t) => t.balance)).toEqual(s.rows.map((row) => row.balance));
    });
  }

  it("keeps amounts in place when a narration is wider in characters than on the page", async () => {
    // Narrow characters (digits, slashes, i/l/t) take more character cells than their width,
    // which pushes the next text to the right in the laid-out text.
    const s = statement(1, OPENING, (n) => `upi/p2a/111111111111/illi fill lilt/1111/i/l/t/${n.toLowerCase()}`.slice(0, 120));
    const pages = await extractPdfPages(tableStatement(s.pages, { headerAlign: "centre" }));
    const pushed = pages[0].lines.flatMap((l) => l.cells).filter((c) => c.col - c.x0 > 2);
    expect(pushed.length).toBeGreaterThan(0); // the layout really did push amounts
    const r = parsePdfPages(pages, FY);
    expect([r.status, r.rejected]).toEqual([EXTRACTED, []]);
    expect(amounts(r)).toEqual(s.expected);
  });
});

describe("Indian number formats and currency marks", () => {
  it("reads lakh/crore grouping, currency prefixes and an overdrawn Dr balance exactly", async () => {
    const rows: TableRow[] = [
      { date: "01/04/2025", narration: "SYNTH OPENING DRAW", debit: "Rs. 1,00,000.00", balance: "50,000.00 Dr" },
      { date: "02/04/2025", narration: "SYNTH BIG RECEIPT", credit: "INR 12,34,56,789.00", balance: "12,34,06,789.00 Cr" },
      { date: "03/04/2025", narration: "SYNTH SMALL FEE", debit: "0.50", balance: "12,34,06,788.50" },
    ];
    const r = await read(tableStatement([rows], { headerAlign: "left" }));
    expect(r.rejected).toEqual([]);
    expect(r.transactions.map((t) => [t.narration, t.debit, t.credit, t.balance])).toEqual([
      ["SYNTH OPENING DRAW", "1,00,000.00", null, "-50,000.00"],
      ["SYNTH BIG RECEIPT", null, "12,34,56,789.00", "12,34,06,789.00"],
      ["SYNTH SMALL FEE", "0.50", null, "12,34,06,788.50"],
    ]);
  });
});

describe("stated, carried-forward and total balances", () => {
  it("checks the opening and closing balances printed above the table", async () => {
    const s = statement(2);
    const summary = { opening: inr(OPENING), closing: s.closing, period: "01/04/2025 to 31/05/2025" };
    const ok = await read(tableStatement(s.pages, { summary }));
    expect([ok.status, ok.statedOpening, ok.statedClosing]).toEqual([EXTRACTED, inr(OPENING), s.closing]);

    const badOpening = await read(tableStatement(s.pages, { summary: { ...summary, opening: inr(OPENING + 100n) } }));
    expect(badOpening.status).toBe(MANUAL_REVIEW);
    expect(badOpening.reviewReasons).toEqual(expect.arrayContaining(["opening_balance_mismatch", "balance_chain_broken"]));
    const badClosing = await read(tableStatement(s.pages, { summary: { ...summary, closing: inr(1n) } }));
    expect([badClosing.status, badClosing.reviewReasons]).toEqual([MANUAL_REVIEW, ["closing_balance_mismatch"]]);
  });

  it("skips B/F and C/F rows across pages and checks them against the rows", async () => {
    const s = statement(3);
    const r = await read(tableStatement(s.pages, { carryForward: true }));
    expect([r.status, r.transactions.length, r.summaryRows]).toEqual([EXTRACTED, 30, 4]);
    expect([...new Set(r.rowPages.values())]).toEqual([1, 2, 3]);

    const broken = statement(3);
    const pdf = tableStatement(broken.pages, { carryForward: true });
    const pages = await extractPdfPages(pdf);
    // Doctor page 2's "Balance B/F" so it no longer matches page 1's last balance.
    const line = pages[1].lines.find((l) => /Balance B\/F/.test(l.text))!;
    const cell = line.cells[line.cells.length - 1];
    line.text = line.text.replace(cell.str, "9,99,999.99");
    cell.str = "9,99,999.99";
    const result = parsePdfPages(pages, FY);
    expect(result.reviewReasons).toContain("carried_forward_mismatch");
    expect(result.status).toBe(MANUAL_REVIEW);
  });

  it("compares a printed total line with the rows read", () => {
    const page = (debitTotal: string) => [
      "Date        Particulars                        Debit          Credit         Balance",
      "01/04/2025  SYNTH A                           250.00                        9,750.00",
      "02/04/2025  SYNTH B                                         1,000.00       10,750.00",
      "03/04/2025  SYNTH C                           100.00                       10,650.00",
      `            Total                        ${debitTotal.padStart(9)}       1,000.00`,
    ].join("\n");
    expect(parsePdfPages([page("350.00")], FY).reviewReasons).toEqual([]);
    expect(parsePdfPages([page("450.00")], FY).reviewReasons).toEqual(["totals_mismatch"]);
  });

  it("reads a CSV opening balance row", () => {
    const csv = new TextEncoder().encode("Date,Narration,Debit,Credit,Balance\n,Opening Balance,,,\"10,000.00\"\n"
      + "01/04/2025,SYNTH A,250.00,,\"9,750.00\"\n,Closing Balance,,,\"9,750.00\"\n");
    const r = parseCsv(csv, FY);
    expect([r.statedOpening, r.statedClosing, r.transactions.length]).toEqual(["10,000.00", "9,750.00", 1]);
  });
});

describe("duplicates, missing rows and ambiguous rows", () => {
  it("flags a row repeated across a page break", async () => {
    const s = statement(2);
    s.pages[1].unshift({ ...s.pages[0][s.pages[0].length - 1] });
    const r = await read(tableStatement(s.pages));
    expect(r.status).toBe(MANUAL_REVIEW);
    expect(r.reviewReasons).toEqual(expect.arrayContaining(["duplicate_looking_rows", "balance_chain_broken"]));
  });

  it("never verifies a statement with a missing row", async () => {
    const s = statement(1);
    s.pages[0].splice(4, 1);
    const r = await read(tableStatement(s.pages, { summary: { opening: inr(OPENING), closing: s.closing, period: "x" } }));
    expect(r.status).toBe(MANUAL_REVIEW);
    expect(r.reviewReasons).toContain("balance_chain_broken");
  });

  // Character-grid pages: "Debit" at 46-51, "Credit" at 61-67, "Balance" at 76-83.
  const header = `Date        Particulars${" ".repeat(23)}Debit${" ".repeat(10)}Credit${" ".repeat(9)}Balance`;
  const row = (date: string, narr: string, amountAt: number, amount: string, balance: string) => {
    const line = `${date}  ${narr}`.padEnd(100).split("");
    line.splice(amountAt, amount.length, ...amount);
    line.splice(83 - balance.length, balance.length, ...balance);
    return line.join("").trimEnd();
  };

  it("settles an amount straddling two columns only when the running balance proves its side", () => {
    const first = row("01/04/2025", "SYNTH A", 45, "250.00", "9,750.00"); // a clear debit (ends at 51)
    // 12,34,567.00 spans 50-62: it crosses into the Credit label and reaches back over the Debit label.
    const straddle = (balance: string) => [header, first, row("02/04/2025", "SYNTH B", 50, "12,34,567.00", balance)].join("\n");
    const settled = parsePdfPages([straddle("12,44,317.00")], FY);
    expect(settled.rejected).toEqual([]);
    expect(amounts(settled)).toEqual([["250.00", null], [null, "12,34,567.00"]]);
    expect([settled.status, settled.reviewReasons]).toEqual([MANUAL_REVIEW, ["directions_from_balance"]]);

    const unsettled = parsePdfPages([straddle("12,345.00")], FY); // the balance fits neither side
    expect(unsettled.rejected).toEqual([{ row: 2, codes: ["ambiguous_columns"], page: 1 }]);
    expect(unsettled.status).toBe(MANUAL_REVIEW);
  });

  it("rejects an amount whose column contradicts the running balance instead of trusting either", () => {
    const page = [header,
      row("01/04/2025", "SYNTH A", 45, "250.00", "9,750.00"),
      row("02/04/2025", "SYNTH B", 45, "1,000.00", "10,750.00"), // printed under Debit, but the balance went up
    ].join("\n");
    const r = parsePdfPages([`Opening Balance 10,000.00\n${page}`], FY);
    expect(r.rejected).toEqual([{ row: 2, codes: ["direction_conflicts_with_balance"], page: 1 }]);
    expect(r.status).toBe(MANUAL_REVIEW);
    expect(r.reviewReasons).toContain("balance_chain_not_verifiable");
  });
});

describe("reconciliation status", () => {
  const rows = (values: [string, string][]) => values.map(([debit, credit]) => ({ is_valid: true, debit, credit }));
  it("distinguishes PASS, FAIL and UNABLE TO VERIFY", () => {
    const pass = verification({ opening_balance: "10000.00", closing_balance: "10750.00" }, "extracted",
      rows([["250.00", "0.00"], ["0.00", "1000.00"]]));
    expect([pass.reconciliation.status, pass.verified]).toEqual(["passed", true]);
    const fail = verification({ opening_balance: "10000.00", closing_balance: "10000.00" }, "extracted",
      rows([["250.00", "0.00"], ["0.00", "1000.00"]]));
    expect([fail.reconciliation.status, fail.verified]).toEqual(["failed", false]);
    const unable = verification({ opening_balance: null, closing_balance: null }, "extracted", rows([["250.00", "0.00"]]));
    expect([unable.reconciliation.status, unable.verified]).toEqual(["not_available", false]);
    const incomplete = verification({ opening_balance: "10000.00", closing_balance: "9750.00" }, "manual_review_required",
      [...rows([["250.00", "0.00"]]), { is_valid: false, debit: null, credit: null }]);
    expect([incomplete.reconciliation.status, incomplete.verified]).toEqual(["incomplete", false]);
  });
});
