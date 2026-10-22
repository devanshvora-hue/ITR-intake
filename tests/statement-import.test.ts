// Statement import: CSV parsing, PDF text extraction (pdf.js) and the PDF
// column rules. Ported from backend/tests/test_statement_{csv,pdf,pdf_zones}.py.
// Every file is synthetic.

import { describe, expect, it } from "vitest";
import { EXTRACTED, MANUAL_REVIEW, parseCsv, parsePdfPages, REJECTED, type ImportResult } from "@/lib/statement/import";
import { containsImages, ExtractionFailed, extractPdfPages } from "@/lib/statement/pdf-text";
import { parseAmount } from "@/lib/statement/validation";
import { checkUpload } from "@/lib/server/statements";
import {
  blankPage, buildPdf, CHAR_W, COL_BAL_R, COL_DATE, COL_NARR, goodPdf, imageOnlyPage, mixedPage, Page, PAGE1, PAGE2,
  PAGE_H, statementPage, type Row,
} from "./helpers/synthetic-pdf";

const FY = "2025-26";
const HEADER = "Date,Narration,Debit,Credit,Balance\n";
const csv = (lines: string[], header = HEADER) => new TextEncoder().encode(header + lines.join("\n") + "\n");
const parse = (data: Uint8Array, fy: string | null = FY) => parseCsv(data, fy);
const valuesOf = (r: ImportResult) => r.transactions.map((t) => [t.date, t.debit, t.credit, t.balance]);

describe("CSV", () => {
  const VALID = csv(["01/04/2025,UPI/1001/SYNTHETIC SHOP,250.00,,9750.00", "02/04/2025,NEFT SALARY SYNTHETIC CO,,50000.00,59750.00",
    "03/04/2025,ATM WDL SYNTHETIC,5000.00,,54750.00"]);

  it("extracts a valid file exactly", () => {
    const r = parse(VALID);
    expect([r.status, r.reviewReasons, r.rejected]).toEqual([EXTRACTED, [], []]);
    expect(r.transactions[0]).toEqual({ rowNumber: 1, date: "01/04/2025", narration: "UPI/1001/SYNTHETIC SHOP",
      debit: "250.00", credit: null, balance: "9750.00" });
    expect([r.periodStart, r.periodEnd]).toEqual(["2025-04-01", "2025-04-03"]);
  });

  it("accepts a missing balance column and a credit-only file", () => {
    const r = parse(csv(["01/04/2025,SYNTHETIC A,100.00,", "02/04/2025,SYNTHETIC B,,200.00"],
      "Txn Date,Description,Withdrawal Amt,Deposit Amt\n"));
    expect(r.status).toBe(EXTRACTED);
    expect(r.transactions[1].balance).toBeNull();
    expect(parse(csv(["01/04/2025,INTEREST SYNTHETIC,25.00"], "Date,Particulars,Credit\n")).status).toBe(EXTRACTED);
  });

  it.each(["01/04/2025", "01-04-2025", "01.04.2025", "2025-04-01", "01-Apr-2025", "01 Apr 2025", "01/04/25"])(
    "reads the date format %s", (raw) => {
      expect(parse(csv([`${raw},SYNTHETIC,10.00,,`]), null).status).toBe(EXTRACTED);
    });

  it("reads dates day first only", () => {
    expect(parse(csv(["02/03/2025,SYNTHETIC,10.00,,"]), null).periodStart).toBe("2025-03-02");
  });

  it.each(["31/02/2025", "04/13/2025", "2025/04/01", "1st April", "45/45/2025", "tomorrow"])(
    "rejects the row with the invalid date %s", (raw) => {
      const r = parse(csv(["01/04/2025,SYNTHETIC OK,10.00,,", `${raw},SYNTHETIC BAD,10.00,,`]));
      expect(r.status).toBe(MANUAL_REVIEW);
      expect(r.rejected).toEqual([{ row: 2, codes: ["invalid_date"] }]);
      expect(r.transactions).toHaveLength(1);
    });

  it.each(["1,23,456.78", "123456.78", "₹ 1,23,456.78", "INR 123,456.78", "1,234"])("reads the amount %s", (raw) => {
    expect(parse(csv([`01/04/2025,SYNTHETIC,"${raw}",,`]), null).status).toBe(EXTRACTED);
  });

  it.each([
    ["abc", "", "debit_invalid_amount"], ["1.234", "", "debit_invalid_amount"], ["-50.00", "", "negative_amount"],
    ["(50.00)", "", "debit_negative_amount"], ["10.00", "20.00", "both_debit_and_credit"], ["", "", "missing_amount"],
    ["12..5", "", "debit_invalid_amount"],
  ])("rejects debit %s / credit %s with %s", (debit, credit, code) => {
    const r = parse(csv([`01/04/2025,SYNTHETIC,${debit},${credit},`]));
    expect(r.status).toBe(MANUAL_REVIEW);
    expect(r.transactions).toEqual([]);
    expect(r.rejected[0].row).toBe(1);
    expect(r.rejected[0].codes).toContain(code);
  });

  it("reads Dr/Cr on balances", () => {
    const r = parse(csv(["01/04/2025,SYNTHETIC,100.00,,1000.00 Dr", "02/04/2025,SYNTHETIC,,100.00,900.00 Dr"]));
    expect(r.status).toBe(EXTRACTED);
    expect(r.transactions[0].balance).toBe("-1000.00");
  });

  it("never fills in a missing date or narration", () => {
    const r = parse(csv([",SYNTHETIC NO DATE,10.00,,", "01/04/2025,,10.00,,"]));
    expect(r.transactions).toEqual([]);
    expect(r.rejected).toEqual([{ row: 1, codes: ["missing_date"] }, { row: 2, codes: ["missing_narration"] }]);
  });

  it.each([
    ["", "empty_file"], ["   \n\n", "empty_file"], [HEADER, "no_data_rows"], ["Date,Narration,Debit,Credit\n\n\n", "no_data_rows"],
    ["When,What,How much\n01/04/2025,SYNTHETIC,10\n", "missing_required_columns"],
    ["Date;Narration;Debit;Credit\n01/04/2025;SYNTHETIC;10.00;\n", "unsupported_delimiter"],
    ["Date,Narration,Debit\n01/04/2025,SYN\u0000,1.00\n", "unsupported_encoding"],
    ['Date,Narration,Debit\n01/04/2025,"unterminated,1.00\n', "malformed_csv"],
  ])("rejects an unusable file (%#) as %s", (text, code) => {
    const r = parse(new TextEncoder().encode(text));
    expect([r.status, r.errorCode, r.transactions]).toEqual([REJECTED, code, []]);
  });

  it("rejects Latin-1 text as an unsupported encoding", () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode("Date,Narration,Debit\n01/04/2025,CAF"), 0xe9,
      ...new TextEncoder().encode(",1.00\n")]);
    expect(parse(latin1).errorCode).toBe("unsupported_encoding");
  });

  it("accepts a BOM, whitespace and a preamble", () => {
    const r = parse(new TextEncoder().encode("﻿ Date , Narration ,Debit,Credit\n 01/04/2025 ,  SYNTHETIC  , 10.00 ,\n"));
    expect(r.status).toBe(EXTRACTED);
    expect(r.transactions[0].narration).toBe("SYNTHETIC");
    expect(parse(new TextEncoder().encode(`Synthetic Bank\nAccount: XXXX0000\n\n${HEADER}01/04/2025,SYNTHETIC,10.00,,90.00\n`)).status)
      .toBe(EXTRACTED);
  });

  it("rejects too many rows or columns", () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => `01/04/2025,SYNTHETIC ${i},1.00,,`);
    expect(parse(csv(rows)).errorCode).toBe("too_many_rows");
    const wide = Array.from({ length: 41 }, (_, i) => `c${i}`).join(",");
    expect(parse(new TextEncoder().encode(`Date,Narration,Debit,${wide}\n`)).errorCode).toBe("too_many_columns");
  });

  it("rejects, never drops, a row with the wrong number of cells or an oversized cell", () => {
    const r = parse(csv(["01/04/2025,SYNTHETIC,10.00,,90.00", "02/04/2025,SYNTHETIC,10.00"]));
    expect(r.rejected).toEqual([{ row: 2, codes: ["column_count_mismatch"] }]);
    expect(r.reviewReasons).toContain("rows_rejected");
    expect(parse(csv([`01/04/2025,${"X".repeat(1001)},10.00,,`])).rejected[0].codes).toEqual(["field_too_long"]);
  });

  it("counts summary rows instead of rejecting them", () => {
    const r = parse(csv(["01/04/2025,SYNTHETIC,10.00,,90.00", ",Closing Balance,,,90.00", ",Total,10.00,,"]));
    expect([r.summaryRows, r.rejected.length, r.transactions.length]).toEqual([2, 0, 1]);
  });

  it("flags duplicate-looking rows, but not repeats with different balances", () => {
    const dup = parse(csv(["01/04/2025,UPI SYNTHETIC TEA,20.00,", "01/04/2025,UPI SYNTHETIC TEA,20.00,"],
      "Date,Narration,Debit,Credit\n"));
    expect(dup.duplicateRows).toEqual([1, 2]);
    expect(dup.reviewReasons).toContain("duplicate_looking_rows");
    expect(parse(csv(["01/04/2025,UPI SYNTHETIC TEA,20.00,,980.00", "01/04/2025,UPI SYNTHETIC TEA,20.00,,960.00"])).status)
      .toBe(EXTRACTED);
  });

  it("checks the balance chain in date order", () => {
    const broken = parse(csv(["01/04/2025,SYNTHETIC A,100.00,,900.00", "02/04/2025,SYNTHETIC B,100.00,,700.00"]));
    expect(broken.reviewReasons).toContain("balance_chain_broken");
    expect(broken.transactions).toHaveLength(2);
    expect(parse(csv(["02/04/2025,SYNTHETIC B,100.00,,800.00", "01/04/2025,SYNTHETIC A,100.00,,900.00"])).status).toBe(EXTRACTED);
    expect(parse(csv(["01/04/2025,SYNTHETIC A,100.00,,900.00", "02/04/2025,SYNTHETIC B,100.00,,"])).reviewReasons)
      .toContain("balance_missing_on_rows");
  });

  it("flags dates outside the financial year and keeps amounts exact", () => {
    expect(parse(csv(["01/04/2024,SYNTHETIC OLD,10.00,,"])).reviewReasons).toContain("dates_outside_financial_year");
    const r = parse(csv(["01/04/2025,SYNTHETIC 1,,0.10,0.10", "02/04/2025,SYNTHETIC 2,,0.10,0.20", "03/04/2025,SYNTHETIC 3,,0.10,0.30"]));
    expect(r.status).toBe(EXTRACTED);
    expect(r.transactions.reduce((s, t) => s + parseAmount(t.credit), 0n)).toBe(30n);
  });
});

// --- PDF: real files through pdf.js -------------------------------------------------------------------------------

async function pdf(pages: Page[], compress = false): Promise<ImportResult> {
  const data = buildPdf(pages, { compress });
  return parsePdfPages(await extractPdfPages(data), FY, containsImages(data));
}

const goodPages = () => [statementPage(PAGE1, { opening: "50,000.00", pageNo: 1 }), statementPage(PAGE2, { closing: "1,28,512.35", pageNo: 2 })];

describe("PDF statements", () => {
  it.each([false, true])("extracts a multi-page digital statement (compressed: %s)", async (compress) => {
    const r = await pdf(goodPages(), compress);
    expect(r.pagesTotal).toBe(2);
    expect([r.status, r.reviewReasons, r.pageWarnings, r.rejected]).toEqual([EXTRACTED, [], [], []]);
    expect(valuesOf(r)).toEqual([["01/04/2025", "1,250.00", null, "48,750.00"], ["03/04/2025", null, "85,000.00", "1,33,750.00"],
      ["04/04/2025", "250.00", null, "1,33,500.00"], ["05/04/2025", "5,000.00", null, "1,28,500.00"],
      ["07/04/2025", null, "12.35", "1,28,512.35"]]);
    expect(r.transactions[1].narration).toBe("NEFT SALARY SYNTHETIC CO REF SYN0001");
    expect([...r.rowPages]).toEqual([[1, 1], [2, 1], [3, 1], [4, 2], [5, 2]]);
    expect(r.summaryRows).toBe(2);
  });

  it("reads alternative column labels", async () => {
    const r = await pdf([statementPage(PAGE1, { opening: "50,000.00", labels: ["Txn Date", "Description", "Debit", "Credit", "Balance"] })]);
    expect(r.status).toBe(EXTRACTED);
    expect(r.transactions).toHaveLength(3);
  });

  it("flags a blank page, image-only pages and mixed pages without calling them complete", async () => {
    const [p1, p2] = goodPages();
    const blank = await pdf([p1, blankPage(), p2]);
    expect(blank.status).toBe(MANUAL_REVIEW);
    expect(blank.pageWarnings).toContainEqual({ page: 2, code: "no_extractable_text" });

    const images = await pdf([imageOnlyPage(), imageOnlyPage()]);
    expect(images.transactions).toEqual([]);
    expect(images.reviewReasons).toEqual(expect.arrayContaining(["pages_without_text", "image_content_not_extracted",
      "unsupported_layout", "no_transactions_found"]));

    const mixed = await pdf([goodPages()[0], mixedPage(), imageOnlyPage()]);
    expect([mixed.status, mixed.transactions.length]).toEqual([MANUAL_REVIEW, 3]);
    expect(mixed.pageWarnings).toEqual(expect.arrayContaining([{ page: 2, code: "no_transactions_on_page" },
      { page: 3, code: "no_extractable_text" }]));
  });

  it("does not guess an unsupported layout", async () => {
    const page = new Page();
    page.text(40, 500, "SYNTHETIC BANK STATEMENT");
    page.text(40, 480, "Date        Details                         Amount        Dr/Cr");
    page.text(40, 460, "01/04/2025  UPI SYNTHETIC SHOP              1,250.00      Dr");
    page.text(40, 440, "02/04/2025  NEFT SYNTHETIC SALARY          85,000.00      Cr");
    const r = await pdf([page]);
    expect(r.transactions).toEqual([]);
    expect(r.reviewReasons).toContain("unsupported_layout");
  });

  it("uses the balance chain to confirm a gap amount and to catch a wrong reading", async () => {
    const gapPage = (balance: string) => {
      const page = statementPage(PAGE1.slice(0, 1), { opening: "50,000.00" });
      page.text(COL_DATE, 300, "02/04/2025").text(COL_NARR, 300, "SYNTHETIC GAP AMOUNT").text(572, 300, "999.00")
        .text(COL_BAL_R - balance.length * CHAR_W, 300, balance);
      return page;
    };
    const ok = await pdf([gapPage("47,751.00")]);
    expect(ok.status).toBe(EXTRACTED);
    expect([ok.transactions[1].debit, ok.transactions[1].credit]).toEqual(["999.00", null]);
    expect((await pdf([gapPage("49,749.00")])).reviewReasons).toContain("balance_chain_broken");
  });

  it("catches a missing row, missing balances, bad rows, stray amounts and cover pages", async () => {
    expect((await pdf([statementPage([PAGE1[0], PAGE1[2]], { opening: "50,000.00" })])).reviewReasons).toContain("balance_chain_broken");
    expect((await pdf([statementPage(PAGE1.map(([d, n, dr, cr]) => [d, n, dr, cr, ""] as Row))])).reviewReasons)
      .toContain("balance_column_missing");
    const bad = await pdf([statementPage([PAGE1[0], ["32/04/2025", "SYNTHETIC BAD DATE", "10.00", "", "48,740.00"]], { opening: "50,000.00" })]);
    expect(bad.rejected).toEqual([{ row: 2, codes: ["invalid_date"], page: 1 }]);
    const stray = statementPage(PAGE1, { opening: "50,000.00" });
    stray.text(COL_NARR, 200, "SOMETHING UNEXPLAINED").text(COL_BAL_R - 8 * CHAR_W, 200, "1,000.00");
    const strayResult = await pdf([stray]);
    expect(strayResult.pageWarnings).toContainEqual({ page: 1, code: "unrecognised_amount_line" });
    expect(strayResult.transactions).toHaveLength(3);
    const cover = new Page().text(40, 500, "SYNTHETIC BANK - STATEMENT OF ACCOUNT - COVER PAGE WITH NO TABLE AT ALL");
    const withCover = await pdf([cover, ...goodPages()]);
    expect(withCover.pageWarnings).toContainEqual({ page: 1, code: "no_transaction_table" });
    expect(withCover.transactions).toHaveLength(5);
  });

  it("fails safely on malformed and truncated PDFs", async () => {
    for (const text of ["%PDF-1.4\nthis is not a pdf at all\n%%EOF\n"]) {
      await expect(extractPdfPages(new TextEncoder().encode(text))).rejects.toBeInstanceOf(ExtractionFailed);
    }
    const data = goodPdf();
    expect(checkUpload(data.subarray(0, data.length / 2), "s.pdf", "application/pdf")).toEqual(["pdf", "truncated_pdf"]);
    expect(parsePdfPages([]).status).toBe(REJECTED);
  });
});

// --- PDF column bands on exact character positions ------------------------------------------------------------------

function textPage(rows: Row[], debitEndCol = 70): string {
  const lines = ["SYNTHETIC BANK STATEMENT FOR TESTING ONLY", "",
    `Date        Particulars${" ".repeat(37)}Debit${" ".repeat(15)}Credit${" ".repeat(14)}Balance`];
  for (const [d, narr, dr, cr, bal] of rows) {
    const line = `${d}  ${narr}`.padEnd(130).split("");
    for (const [value, end] of [[dr, debitEndCol], [cr, 90], [bal, 112]] as const) {
      if (value) line.splice(end - value.length, value.length, ...value);
    }
    lines.push(line.join("").trimEnd());
  }
  return lines.join("\n");
}

describe("column bands", () => {
  it("rejects a row whose amount touches the next column's label", () => {
    const rows: Row[] = [["01/04/2025", "SYN A", "250.00", "", "9,750.00"], ["02/04/2025", "SYN B", "100.00", "", "9,650.00"]];
    const ok = parsePdfPages([textPage(rows)], FY);
    expect([ok.status, ok.transactions.map((t) => t.debit)]).toEqual([EXTRACTED, ["250.00", "100.00"]]);
    const touching = parsePdfPages([textPage(rows, 80)], FY);
    expect([touching.status, touching.transactions]).toEqual([MANUAL_REVIEW, []]);
    expect(touching.rejected.every((x) => x.codes.join() === "ambiguous_columns")).toBe(true);
  });
});

// --- randomised: anything marked extracted must be exactly right ----------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function money(paise: bigint): string {
  const whole = String(paise / 100n);
  const frac = String(paise % 100n).padStart(2, "0");
  if (whole.length <= 3) return `${whole}.${frac}`;
  let head = whole.slice(0, -3);
  const groups: string[] = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  return `${[head, ...groups].filter(Boolean).join(",")},${whole.slice(-3)}.${frac}`;
}

type Col = [key: string, label: string, labelX: number, align: "left" | "centre" | "right", rightX: number];

function textAt(page: Page, x: number, y: number, s: string, align: Col[3]) {
  const width = s.length * CHAR_W;
  page.text(align === "left" ? x : align === "right" ? x - width : x - width / 2, y, s);
}

function layoutPage(cols: Col[], rows: Row[], opts: { header?: boolean; opening?: string; shift?: number } = {}): Page {
  const page = new Page();
  let y = PAGE_H - 40;
  page.text(40, y, "SYNTHETIC BANK STATEMENT FOR TESTING ONLY");
  y -= 30;
  if (opts.header ?? true) {
    page.text(40, y, "Date").text(130, y, "Particulars");
    for (const [, label, lx, align] of cols) textAt(page, lx, y, label, align);
    y -= 16;
  }
  const rights = Object.fromEntries(cols.map(([key, , , , r]) => [key, r]));
  if (opts.opening) {
    page.text(130, y, "Opening Balance");
    textAt(page, rights.balance, y, opts.opening, "right");
    y -= 14;
  }
  for (const [d, narr, dr, cr, bal] of rows) {
    page.text(40, y, d).text(130, y, narr);
    for (const [key, value] of [["debit", dr], ["credit", cr], ["balance", bal]] as const) {
      if (value) textAt(page, rights[key] + (opts.shift ?? 0), y, value, "right");
    }
    y -= 14;
  }
  page.text(40, 30, "Page footer - computer generated synthetic statement");
  return page;
}

const LABELS = { debit: ["Withdrawals", "Debit", "Withdrawal Amt", "Debit Amount"],
  credit: ["Deposits", "Credit", "Deposit Amt", "Credit Amount"], balance: ["Balance", "Closing Balance", "Running Balance"] };
const NARRATIONS = ["UPI SYN SHOP", "NEFT SYN PAYROLL", "ATM SYN CASH", "IMPS SYN TRANSFER", "SYN CARD PAYMENT", "SYN INTEREST",
  "CHQ SYN 000123", "SYN RENT"];

describe("randomised statements", () => {
  it.each([11, 23, 37])("are never extracted wrongly (seed %i)", async (seed) => {
    const rng = mulberry32(seed);
    const uniform = (a: number, b: number) => a + (b - a) * rng();
    const int = (a: number, b: number) => Math.floor(uniform(a, b + 1));
    const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
    const tally = { clean: 0, cleanExtracted: 0 };
    for (let n = 0; n < 24; n++) {
      const widths = [uniform(88, 100), uniform(88, 100), uniform(88, 100)];
      let right = uniform(560, 590);
      let rights: number[] = [];
      for (let i = 0; i < 3; i++) {
        rights.push(right);
        right += widths[Math.min(i + 1, 2)] + uniform(12, 25);
      }
      if (rights[2] > 830) rights = rights.map((r) => r - (rights[2] - 830));
      const cols: Col[] = (["debit", "credit", "balance"] as const).map((key, i) => {
        const align = pick(["left", "centre", "right"] as const);
        const lx = { left: rights[i] - widths[i], centre: rights[i] - widths[i] / 2, right: rights[i] }[align];
        return [key, pick(LABELS[key]), lx, align, rights[i]];
      });
      let balance = BigInt(int(10_000, 500_000)) * 100n + BigInt(int(0, 99));
      const opening = money(balance);
      const pages: Row[][] = [];
      const all: Row[] = [];
      let day = 1;
      for (let p = 0, pc = int(1, 3); p < pc; p++) {
        const rows: Row[] = [];
        for (let r = 0, rc = int(2, 7); r < rc; r++) {
          const amount = BigInt(int(1, 4_000_000));
          let dr = "", cr = "";
          if (rng() < 0.5 && amount < balance) {
            balance -= amount;
            dr = money(amount);
          } else {
            balance += amount;
            cr = money(amount);
          }
          rows.push([`${String(day).padStart(2, "0")}/05/2025`, pick(NARRATIONS), dr, cr, money(balance)]);
          day++;
        }
        pages.push(rows);
        all.push(...rows);
      }
      const perturb = n % 2 === 0 ? null : pick(["headerless_continuation", "shift_page", "swap_one_row"]);
      const built = pages.map((rows, i) => {
        let drawn = rows;
        if (perturb === "swap_one_row" && i === 0) {
          const j = Math.floor(rng() * rows.length);
          drawn = rows.map((row, k) => (k === j ? [row[0], row[1], row[3], row[2], row[4]] : row));
        }
        return layoutPage(cols, drawn, {
          header: !(perturb === "headerless_continuation" && i > 0),
          opening: i === 0 ? opening : undefined,
          shift: perturb === "shift_page" && i === pages.length - 1 ? (rng() < 0.5 ? -1 : 1) * uniform(15, 70) : 0,
        });
      });
      const r = await pdf(built);
      if (r.status === EXTRACTED) {
        // The core guarantee: an extracted statement is exactly the invented one.
        expect(valuesOf(r)).toEqual(all.map(([d, , dr, cr, bal]) => [d, dr || null, cr || null, bal]));
        expect([r.rejected, r.pageWarnings]).toEqual([[], []]);
      }
      if (perturb === null) {
        tally.clean++;
        if (r.status === EXTRACTED) tally.cleanExtracted++;
      }
      if (perturb === "swap_one_row") expect(r.status).not.toBe(EXTRACTED);
      if (perturb === "headerless_continuation" && pages.length > 1) expect(r.status).not.toBe(EXTRACTED);
    }
    // The rules must read ordinary layouts, not just reject everything.
    expect(tally.cleanExtracted * 3).toBeGreaterThanOrEqual(tally.clean * 2);
  });
});
