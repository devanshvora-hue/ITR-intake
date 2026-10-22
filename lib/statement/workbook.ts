// Internal Excel workbook for the CA firm (port of backend/itr_intake/workbook.py,
// without the optional AIS sheet). Built only from stored, classified rows; it
// classifies nothing itself and must never be shown to the client.
//
// Live formulas (update when a category is changed in "All Transactions"):
// Summary category table, reconciliation totals, key figures, and the totals
// row on each category sheet. Written at generation time (do not update):
// which rows appear on each category sheet and "Needs Review", the
// "at generation" reconciliation values and the validation row counts.

import ExcelJS from "exceljs";
import { CATEGORIES, money, type Category, type ClassifiedTransaction } from "./classifier";
import { formatPaise } from "./validation";

export const DISCLAIMER =
  "This summary has been prepared only from the bank statement(s) provided, as an aid to preparing the Income Tax "
  + "Return. It is not a tax computation, opinion or certification. Classification is based on bank narrations and "
  + "transaction patterns and may not reflect the true nature of every transaction. Before filing, the figures must be "
  + "checked and reconciled with Form 26AS, the Annual Information Statement (AIS) and the Taxpayer Information Summary "
  + "(TIS), and, where applicable, with capital gains statements from brokers / RTAs. The user is advised to consult a "
  + "Chartered Accountant before filing the return.";
export const INTERNAL_BANNER = "INTERNAL – for CA firm review only. Do not share with the client.";

// Indian digit grouping (1,23,45,678.00).
const INR_FORMAT = String.raw`[>=10000000]##\,##\,##\,##0.00;[>=100000]##\,##\,##0.00;##,##0.00`;
const DATE_FORMAT = "DD-MM-YYYY";
const SHEET_SUMMARY = "Summary";
const SHEET_ALL = "All Transactions";
const SHEET_REVIEW = "Needs Review";
const SHEET_LISTS = "Lists";
const STATUS_RECONCILED = "RECONCILED";
const STATUS_NOT_RECONCILED = "NOT RECONCILED";
const STATUS_INCOMPLETE = "INCOMPLETE – rows rejected";
const RESERVED = new Set([SHEET_SUMMARY, SHEET_ALL, SHEET_REVIEW, "AIS - 26AS Reconciliation", SHEET_LISTS, "History"]);

const ALL_COLUMNS: [string, number][] = [
  ["Row #", 7], ["Date", 12], ["Mode", 13], ["Counterparty", 24], ["Debit (₹)", 15], ["Credit (₹)", 15], ["Balance (₹)", 16],
  ["Narration", 58], ["Category", 32], ["Confidence", 11], ["Review status", 18], ["Classification reason", 70],
  ["Flags", 18], ["Rule", 26],
];
const COL = Object.fromEntries(ALL_COLUMNS.map(([name], i) => [name, i + 1])) as Record<string, number>;
const CATEGORY_COLUMNS: [string, number][] = [["Date", 12], ["Mode", 13], ["Counterparty", 24], ["Debit (₹)", 15],
  ["Credit (₹)", 15], ["Balance (₹)", 16], ["Narration", 58], ["Remarks", 70]];
const CANDIDATES: Record<"credit" | "debit", Category[]> = {
  credit: ["Business / Professional Receipts", "Rent Received", "Gifts / Receipts from Non-relatives",
    "Loans Received / Repayment of Loans Given", "Sale / Redemption of Investments"],
  debit: ["Personal Expenses", "Business / Professional Expenses", "Rent Paid", "Loans Given", "Donations"],
};

// --- styling --------------------------------------------------------------------------------------------------

const argb = (hex: string) => ({ argb: `FF${hex}` });
const solid = (hex: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: argb(hex) });
const HEADER_FILL = solid("E3EFE9");
const SECTION_FONT: Partial<ExcelJS.Font> = { bold: true, size: 12, color: argb("0F6B5F") };
const TITLE_FONT: Partial<ExcelJS.Font> = { bold: true, size: 15, color: argb("1D1B18") };
const BOLD: Partial<ExcelJS.Font> = { bold: true };
const RED_FILL = solid("F5D0C8");
const RED_FONT: Partial<ExcelJS.Font> = { bold: true, color: argb("8F1D0B") };
const GREEN_FILL = solid("CFE8DC");
const GREEN_FONT: Partial<ExcelJS.Font> = { bold: true, color: argb("0A4F46") };
const AMBER_FILL = solid("F7ECD6");
const BANNER_FONT: Partial<ExcelJS.Font> = { bold: true, color: argb("8A5A10") };
const NOTE_FONT: Partial<ExcelJS.Font> = { italic: true, color: argb("57524A") };
const TOTAL_BORDER: Partial<ExcelJS.Borders> = { top: { style: "thin", color: argb("1D1B18") } };
const WRAP_TOP: Partial<ExcelJS.Alignment> = { wrapText: true, vertical: "top" };

export type StatementMetadata = {
  clientName: string; clientReference: string; bankName?: string | null; accountNumber?: string | null;
  financialYear?: string | null; periodStart?: string | null; periodEnd?: string | null; dataSourceNote?: string | null;
};

export type Reconciliation = {
  status: "passed" | "failed" | "incomplete"; opening: bigint; stated: bigint; difference: bigint;
};

export type WorkbookInput = {
  transactions: ClassifiedTransaction[];
  rowsReceived: number;
  invalidCount: number;
  reconciliation: Reconciliation | null;
  metadata: StatementMetadata;
  /** Line written in Summary!A3 (the verification status), with its colours. */
  statusLine?: { text: string; verified: boolean };
};

export function maskAccount(number: string | null | undefined): string {
  if (!number) return "Not provided";
  const digits = number.replace(/\D/g, "");
  return digits.length >= 4 ? `XXXX${digits.slice(-4)}` : "XXXX";
}

/** Excel-safe, unique (case-insensitive) sheet name of at most 31 characters. */
export function safeSheetName(name: string, taken: Set<string>): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, "-").split(/\s+/).filter(Boolean).join(" ").replace(/^'+|'+$/g, "") || "Sheet";
  const base = cleaned.slice(0, 31).trimEnd();
  const lowered = new Set([...taken, ...RESERVED].map((t) => t.toLowerCase()));
  let candidate = base;
  for (let n = 2; lowered.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length).trimEnd() + suffix;
  }
  return candidate;
}

const quote = (sheet: string) => (/^[A-Za-z0-9_]+$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`);
const letter = (col: number) => {
  let s = "";
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const rangeRef = (sheet: string, col: number, first: number, last: number) =>
  `${quote(sheet)}!$${letter(col)}$${first}:$${letter(col)}$${last}`;
const toDate = (iso: string) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
const num = (paise: bigint) => Number(formatPaise(paise)); // cell value; the exact text stays in the database
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

function header(ws: ExcelJS.Worksheet, row: number, columns: [string, number][]) {
  columns.forEach(([name, width], i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = name;
    cell.font = BOLD;
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
    ws.getColumn(i + 1).width = width;
  });
}

function moneyCell(cell: ExcelJS.Cell) {
  cell.numFmt = INR_FORMAT;
}

const needsReview = (t: ClassifiedTransaction) =>
  t.reviewStatus !== "Auto-classified" || t.category === "Others – Needs Review" || t.flags.length > 0;

function remarks(t: ClassifiedTransaction): string {
  const status = t.reviewStatus === "Auto-classified" ? "" : `[${t.reviewStatus}] `;
  const flags = t.flags.length ? ` Flags: ${t.flags.join(", ")}.` : "";
  return `${status}${t.classificationReason}${flags}`;
}

// --- sheets -------------------------------------------------------------------------------------------------

function writeAll(ws: ExcelJS.Worksheet, txns: ClassifiedTransaction[], listRef: string): number {
  header(ws, 1, ALL_COLUMNS);
  txns.forEach((t, i) => {
    const r = i + 2;
    const values: Record<string, ExcelJS.CellValue> = {
      "Row #": t.rowNumber, "Date": toDate(t.date), "Mode": t.mode, "Counterparty": t.counterparty ?? "",
      "Debit (₹)": t.debit ? num(t.debit) : null, "Credit (₹)": t.credit ? num(t.credit) : null,
      "Balance (₹)": t.balance === null ? null : num(t.balance), "Narration": t.narration, "Category": t.category,
      "Confidence": t.confidence, "Review status": t.reviewStatus, "Classification reason": t.classificationReason,
      "Flags": t.flags.join(", "), "Rule": t.matchedRule,
    };
    for (const [name, value] of Object.entries(values)) {
      const cell = ws.getCell(r, COL[name]);
      cell.value = value; // strings (including narrations starting with "=") are written as text, never formulas
      if (name === "Date") cell.numFmt = DATE_FORMAT;
      else if (name.endsWith("(₹)")) moneyCell(cell);
      else if (name === "Narration" || name === "Classification reason") cell.alignment = WRAP_TOP;
    }
  });
  const last = Math.max(txns.length + 1, 2);
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  ws.autoFilter = `A1:${letter(ALL_COLUMNS.length)}${last}`;
  const catCol = letter(COL.Category);
  const validation: ExcelJS.DataValidation = {
    type: "list", allowBlank: false, formulae: [listRef], showErrorMessage: true,
    error: "Choose one of the 28 canonical categories.",
  };
  // One range-wide rule (exceljs supports it at runtime; its type definitions omit it).
  const ranged = (ws as unknown as { dataValidations?: { add: (range: string, v: ExcelJS.DataValidation) => void } }).dataValidations;
  if (ranged?.add) ranged.add(`${catCol}2:${catCol}${last}`, validation);
  else for (let r = 2; r <= last; r++) ws.getCell(`${catCol}${r}`).dataValidation = validation;
  return last;
}

function writeCategorySheet(wb: ExcelJS.Workbook, category: Category, txns: ClassifiedTransaction[], taken: Set<string>) {
  const name = safeSheetName(category, taken);
  taken.add(name);
  const ws = wb.addWorksheet(name);
  ws.getCell(1, 1).value = category;
  ws.getCell(1, 1).font = SECTION_FONT;
  ws.getCell(1, 4).value = "Snapshot at generation; see Summary for live totals.";
  ws.getCell(1, 4).font = NOTE_FONT;
  header(ws, 2, CATEGORY_COLUMNS);
  txns.forEach((t, i) => {
    const r = i + 3;
    const row: ExcelJS.CellValue[] = [toDate(t.date), t.mode, t.counterparty ?? "", t.debit ? num(t.debit) : null,
      t.credit ? num(t.credit) : null, t.balance === null ? null : num(t.balance), t.narration, remarks(t)];
    row.forEach((value, c) => {
      const cell = ws.getCell(r, c + 1);
      cell.value = value;
      if (c === 0) cell.numFmt = DATE_FORMAT;
      else if (c >= 3 && c <= 5) moneyCell(cell);
      else if (c >= 6) cell.alignment = WRAP_TOP;
    });
  });
  const first = 3, last = txns.length + 2, total = last + 1;
  ws.getCell(total, 1).value = "Total";
  ws.getCell(total, 1).font = BOLD;
  for (const c of [4, 5]) {
    const cell = ws.getCell(total, c);
    cell.value = { formula: `SUM(${letter(c)}${first}:${letter(c)}${last})` };
    cell.font = BOLD;
    cell.border = TOTAL_BORDER;
    moneyCell(cell);
  }
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 2 }];
  ws.autoFilter = `A2:${letter(CATEGORY_COLUMNS.length)}${last}`;
}

function writeNeedsReview(ws: ExcelJS.Worksheet, txns: ClassifiedTransaction[]) {
  const columns: [string, number][] = [["Row #", 7], ["Date", 12], ["Debit (₹)", 15], ["Credit (₹)", 15], ["Narration", 50],
    ["Current category", 30], ["Suggested category", 44], ["Review status", 18], ["Flags", 18], ["Reason", 70]];
  header(ws, 1, columns);
  const rows = txns.filter(needsReview);
  rows.forEach((t, i) => {
    const r = i + 2;
    const suggested = t.category === "Others – Needs Review"
      ? `Not determined. Possible categories for CA consideration: ${CANDIDATES[t.credit > 0n ? "credit" : "debit"].join("; ")}`
      : `${t.category} (classifier result – confirm)`;
    const values: ExcelJS.CellValue[] = [t.rowNumber, toDate(t.date), t.debit ? num(t.debit) : null, t.credit ? num(t.credit) : null,
      t.narration, t.category, suggested, t.reviewStatus, t.flags.join(", "), t.classificationReason];
    values.forEach((value, c) => {
      const cell = ws.getCell(r, c + 1);
      cell.value = value;
      if (c === 1) cell.numFmt = DATE_FORMAT;
      else if (c === 2 || c === 3) moneyCell(cell);
      else if (c === 4 || c === 6 || c === 9) cell.alignment = WRAP_TOP;
    });
  });
  if (!rows.length) ws.getCell(2, 1).value = "No transactions need review.";
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 1 }];
  ws.autoFilter = `A1:${letter(columns.length)}${Math.max(rows.length + 1, 2)}`;
}

function writeSummary(ws: ExcelJS.Worksheet, input: WorkbookInput, last: number) {
  const { metadata: meta, reconciliation: rec } = input;
  const txns = input.transactions;
  ws.getColumn(1).width = 44;
  for (const c of [2, 3, 4, 5]) ws.getColumn(c).width = 18;
  ws.getColumn(6).width = 30;
  const labelValue = (row: number, label: string, value: ExcelJS.CellValue, isMoney = false) => {
    ws.getCell(row, 1).value = label;
    ws.getCell(row, 1).font = BOLD;
    const cell = ws.getCell(row, 2);
    cell.value = value;
    if (isMoney) moneyCell(cell);
    return cell;
  };
  const formula = (f: string) => ({ formula: f.replace(/^=/, "") });

  ws.getCell("A1").value = "ITR Intake – Bank Statement Summary";
  ws.getCell("A1").font = TITLE_FONT;
  ws.getCell("A2").value = INTERNAL_BANNER;
  ws.getCell("A2").font = BANNER_FONT;
  ws.getCell("A2").fill = AMBER_FILL;
  ws.mergeCells("A2:F2");
  if (input.statusLine) {
    const cell = ws.getCell("A3");
    cell.value = input.statusLine.text;
    cell.fill = solid(input.statusLine.verified ? "DDEFE9" : "F8D7DA");
    cell.font = { bold: true, color: argb(input.statusLine.verified ? "1F5F55" : "9B1C2C") };
    ws.mergeCells("A3:F3");
  }

  let row = 4;
  ws.getCell(row, 1).value = "Client and statement";
  ws.getCell(row, 1).font = SECTION_FONT;
  const period = meta.periodStart && meta.periodEnd ? `${dmy(meta.periodStart)} to ${dmy(meta.periodEnd)}` : "Not provided";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const generated = `${pad(now.getUTCDate())}-${pad(now.getUTCMonth() + 1)}-${now.getUTCFullYear()} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())} UTC`;
  const details: [string, ExcelJS.CellValue][] = [
    ["Client name", meta.clientName], ["Client reference", meta.clientReference], ["Bank", meta.bankName || "Not provided"],
    ["Account number", maskAccount(meta.accountNumber)], ["Financial year", meta.financialYear || "Not provided"],
    ["Statement period", period], ["Generated on", generated], ["Rows received", input.rowsReceived],
    ["Rows accepted", txns.length], ["Rows rejected by validation", input.invalidCount],
  ];
  if (meta.dataSourceNote) details.push(["Data source", meta.dataSourceNote]);
  let rejectedRow = 0;
  for (const [label, value] of details) {
    row++;
    const cell = labelValue(row, label, value);
    if (label === "Rows rejected by validation") {
      rejectedRow = row;
      if (input.invalidCount) {
        cell.font = RED_FONT;
        cell.fill = RED_FILL;
      }
    }
  }

  const allDebit = rangeRef(SHEET_ALL, COL["Debit (₹)"], 2, last);
  const allCredit = rangeRef(SHEET_ALL, COL["Credit (₹)"], 2, last);
  const allCat = rangeRef(SHEET_ALL, COL.Category, 2, last);

  row += 2;
  ws.getCell(row, 1).value = "Balance reconciliation";
  ws.getCell(row, 1).font = SECTION_FONT;
  if (rec === null) {
    row++;
    const cell = ws.getCell(row, 1);
    cell.value = "Reconciliation could not be performed: opening or closing balance is invalid.";
    cell.font = RED_FONT;
    cell.fill = RED_FILL;
  } else {
    const opening = labelValue(++row, "Opening balance (statement)", num(rec.opening), true).address;
    const credits = labelValue(++row, "Total credits", formula(`SUM(${allCredit})`), true).address;
    const debits = labelValue(++row, "Total debits", formula(`SUM(${allDebit})`), true).address;
    const expected = labelValue(++row, "Expected closing balance", formula(`${opening}+${credits}-${debits}`), true).address;
    const stated = labelValue(++row, "Closing balance (statement)", num(rec.stated), true).address;
    const diff = labelValue(++row, "Difference (statement − expected)", formula(`${stated}-${expected}`), true).address;
    const tol = labelValue(++row, "Tolerance", 0.01, true).address;
    const live = labelValue(++row, "Status (live)", formula(
      `IF(B${rejectedRow}>0,"${STATUS_INCOMPLETE}",IF(ABS(${diff})<=${tol},"${STATUS_RECONCILED}","${STATUS_NOT_RECONCILED}"))`));
    ws.addConditionalFormatting({ ref: live.address, rules: [
      [STATUS_RECONCILED, "CFE8DC", "0A4F46"], [STATUS_NOT_RECONCILED, "F5D0C8", "8F1D0B"], [STATUS_INCOMPLETE, "F5D0C8", "8F1D0B"],
    ].map(([value, fill, font], i) => ({
      type: "cellIs", operator: "equal", priority: i + 1, formulae: [`"${value}"`],
      style: { fill: { type: "pattern", pattern: "solid", bgColor: argb(fill) }, font: { bold: true, color: argb(font) } },
    })) });
    const passed = rec.status === "passed";
    const atGen = labelValue(++row, "Status at generation",
      { passed: STATUS_RECONCILED, failed: STATUS_NOT_RECONCILED, incomplete: STATUS_INCOMPLETE }[rec.status]);
    atGen.fill = passed ? GREEN_FILL : RED_FILL;
    atGen.font = passed ? GREEN_FONT : RED_FONT;
    const diffAtGen = labelValue(++row, "Difference at generation", num(rec.difference), true);
    if (!passed) {
      diffAtGen.fill = RED_FILL;
      diffAtGen.font = RED_FONT;
      row++;
      const cell = ws.getCell(row, 1);
      cell.value = rec.status === "failed"
        ? `The statement does NOT reconcile: the stated closing balance differs from opening balance + credits − debits by ${money(rec.difference)}. No amounts have been adjusted.`
        : "Some rows were rejected by validation, so the statement cannot be confirmed as reconciled. Review the rejected rows before relying on these totals.";
      cell.font = RED_FONT;
      cell.fill = RED_FILL;
      cell.alignment = WRAP_TOP;
      ws.mergeCells(row, 1, row, 6);
      ws.getRow(row).height = 32;
    }
  }

  row += 2;
  ws.getCell(row, 1).value = "Totals by category (live from All Transactions)";
  ws.getCell(row, 1).font = SECTION_FONT;
  row++;
  ["Category", "Count", "Debit (₹)", "Credit (₹)", "Net (₹)"].forEach((name, i) => {
    const cell = ws.getCell(row, i + 1);
    cell.value = name;
    cell.font = BOLD;
    cell.fill = HEADER_FILL;
  });
  const firstCat = row + 1;
  for (const name of CATEGORIES) {
    row++;
    ws.getCell(row, 1).value = name;
    ws.getCell(row, 2).value = formula(`COUNTIF(${allCat},A${row})`);
    for (const [c, f] of [[3, `SUMIFS(${allDebit},${allCat},A${row})`], [4, `SUMIFS(${allCredit},${allCat},A${row})`],
      [5, `D${row}-C${row}`]] as const) {
      ws.getCell(row, c).value = formula(f);
      moneyCell(ws.getCell(row, c));
    }
  }
  const lastCat = row;
  row++;
  ws.getCell(row, 1).value = "Total";
  ws.getCell(row, 1).font = BOLD;
  ws.getCell(row, 1).border = TOTAL_BORDER;
  for (let c = 2; c <= 5; c++) {
    const cell = ws.getCell(row, c);
    cell.value = formula(`SUM(${letter(c)}${firstCat}:${letter(c)}${lastCat})`);
    cell.font = BOLD;
    cell.border = TOTAL_BORDER;
    if (c > 2) moneyCell(cell);
  }
  row++;
  ws.getCell(row, 1).value = "Check: uncategorised or invalid category labels";
  ws.getCell(row, 1).font = NOTE_FONT;
  ws.getCell(row, 2).value = formula(`COUNTA(${allCat})-B${row - 1}`);

  row += 2;
  ws.getCell(row, 1).value = "Key figures (as classified; not tax figures)";
  ws.getCell(row, 1).font = SECTION_FONT;
  const keyFigures: [string, Category, "credit" | "debit"][] = [
    ["Credits classified as Salary / Pension", "Salary / Pension", "credit"],
    ["Savings bank interest credited", "Interest – Savings Bank", "credit"],
    ["FD / RD / other interest credited", "Interest – FD / RD / Others", "credit"],
    ["Dividends credited", "Dividend", "credit"],
    ["Income tax refunds received", "Income Tax Refund", "credit"],
    ["Payments classified as Tax Payments", "Tax Payments", "debit"],
    ["Payments to tax-saving type instruments", "Investments – Tax-saving", "debit"],
    ["Health insurance payments", "Insurance – Health", "debit"],
    ["Loan EMI / repayments", "Loan EMI / Repayment", "debit"],
    ["Cash withdrawals", "Cash Withdrawal", "debit"],
    ["Cash deposits", "Cash Deposit", "credit"],
    ["Credits still in Others – Needs Review", "Others – Needs Review", "credit"],
    ["Debits still in Others – Needs Review", "Others – Needs Review", "debit"],
  ];
  for (const [label, category, side] of keyFigures) {
    labelValue(++row, label, formula(`SUMIFS(${side === "credit" ? allCredit : allDebit},${allCat},"${category}")`), true);
  }
  const statusRange = rangeRef(SHEET_ALL, COL["Review status"], 2, last);
  labelValue(++row, "Transactions not auto-classified (live)",
    formula(`COUNTIF(${statusRange},"<>Auto-classified")-COUNTBLANK(${statusRange})`));
  labelValue(++row, "Unexplained credits ≥ ₹50,000 (at generation)", txns.filter((t) => t.flags.includes("large_credit")).length);

  row += 2;
  ws.getCell(row, 1).value = "Notes and assumptions";
  ws.getCell(row, 1).font = SECTION_FONT;
  const notes = [
    "Amounts and narrations are reproduced exactly as extracted; nothing has been adjusted or rounded.",
    "Categories describe what each transaction appears to be from its narration. They are not conclusions on whether any amount is taxable, exempt or deductible.",
    "To reclassify, change the Category in 'All Transactions' (choose from the list). The totals, reconciliation and key figures above are live formulas and update automatically.",
    "Category sheets, 'Needs Review' and the 'at generation' values are a snapshot written when the workbook was generated; they do not move rows when categories are changed.",
    "The large-credit review threshold (₹50,000) and the reconciliation tolerance (₹0.01) are configurable settings, not legal thresholds.",
    "Recurring credits are flagged for confirmation but not assigned an income category.",
    "AIS / Form 26AS reconciliation appears only if those reports were supplied.",
  ];
  for (const note of notes) {
    row++;
    const cell = ws.getCell(row, 1);
    cell.value = `• ${note}`;
    cell.alignment = WRAP_TOP;
    ws.mergeCells(row, 1, row, 6);
    ws.getRow(row).height = 30;
  }
  row += 2;
  ws.getCell(row, 1).value = "Disclaimer";
  ws.getCell(row, 1).font = SECTION_FONT;
  row++;
  const disclaimer = ws.getCell(row, 1);
  disclaimer.value = DISCLAIMER;
  disclaimer.alignment = WRAP_TOP;
  disclaimer.fill = AMBER_FILL;
  ws.mergeCells(row, 1, row, 6);
  ws.getRow(row).height = 105;
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: 3 }];
}

/** Build the internal workbook as .xlsx bytes. */
export async function buildWorkbook(input: WorkbookInput): Promise<Uint8Array> {
  const txns = [...input.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rowNumber - b.rowNumber));
  const wb = new ExcelJS.Workbook();
  wb.creator = "ITR Intake";
  const summary = wb.addWorksheet(SHEET_SUMMARY);
  const all = wb.addWorksheet(SHEET_ALL);
  const listRef = `${SHEET_LISTS}!$A$1:$A$${CATEGORIES.length}`;
  const last = writeAll(all, txns, listRef);
  const taken = new Set([SHEET_SUMMARY, SHEET_ALL, SHEET_LISTS]);
  for (const category of CATEGORIES) {
    const rows = txns.filter((t) => t.category === category);
    if (rows.length) writeCategorySheet(wb, category, rows, taken);
  }
  writeNeedsReview(wb.addWorksheet(SHEET_REVIEW), txns);
  writeSummary(summary, { ...input, transactions: txns }, last);
  const lists = wb.addWorksheet(SHEET_LISTS, { state: "hidden" });
  CATEGORIES.forEach((name, i) => { lists.getCell(i + 1, 1).value = name; });
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
