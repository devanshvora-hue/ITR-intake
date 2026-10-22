// Turn an uploaded bank statement (CSV text, or PDF page text) into raw rows
// and decide, conservatively, whether the extraction can be trusted. A port of
// backend/itr_intake/statement_import.py; see that file for the supported
// layouts. Pure functions only: no files, network or database.
//
// Outcomes: `extracted` (every check passed), `manual_review_required`
// (something usable but unconfirmed; partial results are kept, never shown as
// complete), `rejected` (the file itself is unusable). Nothing is guessed: a
// missing date, narration or amount is never filled in, and rejected rows are
// reported by number and reason codes, never by their contents.

import type { PdfPage } from "./pdf-text";
import {
  balanceChainHolds, parseAmount, parseDate, RECONCILIATION_TOLERANCE, validateRows, type RawTransaction,
} from "./validation";

export const EXTRACTED = "extracted";
export const MANUAL_REVIEW = "manual_review_required";
export const REJECTED = "rejected";

const MAX_CSV_ROWS = 10_000;
const MAX_CSV_COLUMNS = 40;
const MAX_FIELD_CHARS = 1_000;
const MAX_PREAMBLE_LINES = 20;
const MAX_PDF_TRANSACTIONS = 10_000;
const MIN_PAGE_TEXT_CHARS = 30;

const HEADER_SYNONYMS: Record<string, string[]> = {
  date: ["date", "txn date", "tran date", "transaction date", "value date", "post date", "posting date"],
  narration: ["narration", "description", "particulars", "details", "remarks", "transaction details", "transaction remarks"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "withdrawal amt", "withdrawal amt.", "withdrawal amount",
    "debit amount", "dr", "debit amt"],
  credit: ["credit", "credits", "deposit", "deposits", "deposit amt", "deposit amt.", "deposit amount", "credit amount",
    "cr", "credit amt"],
  balance: ["balance", "closing balance", "balance amount", "running balance", "balance amt"],
};

export type RowRejection = { row: number; codes: string[]; page?: number };
export type PageWarning = { page: number; code: string };

export type ImportResult = {
  fileType: "csv" | "pdf";
  status: string;
  transactions: RawTransaction[];
  rejected: RowRejection[];
  duplicateRows: number[];
  reviewReasons: string[];
  pageWarnings: PageWarning[];
  pagesTotal: number | null;
  summaryRows: number;
  errorCode: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  rowPages: Map<number, number>;
  /** Opening and closing balances printed on the statement (not derived from rows), when found. */
  statedOpening: string | null;
  statedClosing: string | null;
};

export function rejectedFile(fileType: "csv" | "pdf", code: string): ImportResult {
  return { fileType, status: REJECTED, transactions: [], rejected: [], duplicateRows: [], reviewReasons: [],
    pageWarnings: [], pagesTotal: null, summaryRows: 0, errorCode: code, periodStart: null, periodEnd: null,
    rowPages: new Map(), statedOpening: null, statedClosing: null };
}

function normHeader(cell: string): string {
  return cell.trim().replace(/^﻿|﻿$/g, "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ")
    .replace(/^[ :.]+|[ :.]+$/g, "");
}

function fyBounds(financialYear: string | null): [string, string] | null {
  if (!financialYear || !/^\d{4}-\d{2}$/.test(financialYear)) return null;
  const start = Number(financialYear.slice(0, 4));
  return [`${start}-04-01`, `${start + 1}-03-31`];
}

/** Normalise an amount cell: strip currency marks and, for balances, a trailing Cr/Dr. [text, errorCode]. */
export function cleanAmountText(raw: string | null, balance: boolean): [string | null, string | null] {
  if (raw === null) return [null, null];
  let text = raw.trim();
  if (text === "" || text === "-" || text === "--") return [null, null];
  text = text.replace(/^(?:₹|INR|Rs\.?)\s*/i, "");
  let sign = "";
  if (balance) {
    const m = /^(.*?)\s*(Cr|CR|cr|Dr|DR|dr)\.?$/s.exec(text);
    if (m) {
      text = m[1].trim();
      sign = m[2].toLowerCase() === "dr" ? "-" : "";
    }
  }
  if (text.startsWith("(") && text.endsWith(")")) return [null, "negative_amount"];
  if (!/^(?:-?\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)$/.test(text)) return [null, "invalid_amount"];
  if (sign === "-") {
    if (text.startsWith("-")) return [null, "invalid_amount"];
    text = `-${text}`;
  }
  return [text, null];
}

function finish(fileType: "csv" | "pdf", rows: RawTransaction[], preRejected: Map<number, string[]>, opts: {
  financialYear: string | null; review: string[]; pageWarnings: PageWarning[]; pagesTotal: number | null;
  summaryRows: number; rowPages: Map<number, number>; requireBalanceChain: boolean; statedOpening?: string | null;
  statedClosing?: string | null; statedTotals?: { debit: string | null; credit: string | null } | null;
}): ImportResult {
  const rejected = new Map<number, string[]>([...preRejected].map(([n, c]) => [n, [...c]]));
  const candidates = rows.filter((r) => !rejected.has(r.rowNumber));
  const report = validateRows(candidates);
  for (const issue of report.errors) {
    rejected.set(issue.rowNumber, [...(rejected.get(issue.rowNumber) ?? []), issue.code]);
  }
  const valid = candidates.filter((r) => !rejected.has(r.rowNumber));
  const txns = new Map(report.transactions.map((t) => [t.rowNumber, t]));
  const review = opts.review;

  const bounds = fyBounds(opts.financialYear);
  if (bounds && valid.some((r) => {
    const d = txns.get(r.rowNumber)!.date;
    return d < bounds[0] || d > bounds[1];
  })) review.push("dates_outside_financial_year");

  // Duplicate-looking rows: identical date, narration, amounts and balance. Kept and flagged.
  const key = (r: RawTransaction) => JSON.stringify([r.date, r.narration, r.debit, r.credit, r.balance]);
  const counts = new Map<string, number>();
  valid.forEach((r) => counts.set(key(r), (counts.get(key(r)) ?? 0) + 1));
  const duplicates = valid.filter((r) => (counts.get(key(r)) ?? 0) > 1).map((r) => r.rowNumber);
  if (duplicates.length) review.push("duplicate_looking_rows");

  const hasBalances = valid.length > 0 && valid.every((r) => txns.get(r.rowNumber)!.balance !== null);
  if (valid.length && !hasBalances) {
    if (valid.some((r) => txns.get(r.rowNumber)!.balance !== null)) review.push("balance_missing_on_rows");
    else if (opts.requireBalanceChain) review.push("balance_column_missing");
  }
  const statedOpening = opts.statedOpening ?? null;
  const statedClosing = opts.statedClosing ?? null;
  if (valid.length && hasBalances && rejected.size === 0) {
    const ordered = valid.map((r) => txns.get(r.rowNumber)!);
    if (ordered.length > 1 && ordered[0].date > ordered[ordered.length - 1].date) ordered.reverse(); // newest first
    const first = ordered[0];
    const derived = (first.balance as bigint) - first.credit + first.debit;
    if (statedOpening !== null && parseAmount(statedOpening, true) !== derived) review.push("opening_balance_mismatch");
    if (statedClosing !== null && parseAmount(statedClosing, true) !== ordered[ordered.length - 1].balance) {
      review.push("closing_balance_mismatch");
    }
    if (!balanceChainHolds(ordered, statedOpening !== null ? parseAmount(statedOpening, true) : derived)) {
      review.push("balance_chain_broken");
    }
  } else if (opts.requireBalanceChain && valid.length && rejected.size) {
    review.push("balance_chain_not_verifiable");
  }
  const totals = opts.statedTotals;
  if (totals && rejected.size === 0) {
    const sum = (key: "debit" | "credit") => valid.reduce((acc, r) => acc + txns.get(r.rowNumber)![key], 0n);
    const stated = (text: string) => parseAmount(text.replace(/\s?(cr|dr)$/i, ""));
    if ((totals.debit !== null && stated(totals.debit) !== sum("debit"))
        || (totals.credit !== null && stated(totals.credit) !== sum("credit"))) {
      review.push("totals_mismatch");
    }
  }
  if (rejected.size) review.push("rows_rejected");
  if (!valid.length) review.push("no_transactions_found");

  const dates = valid.map((r) => txns.get(r.rowNumber)!.date).sort();
  const reasons = [...new Set(review)];
  return {
    fileType,
    status: reasons.length || opts.pageWarnings.length || rejected.size ? MANUAL_REVIEW : EXTRACTED,
    transactions: valid,
    rejected: [...rejected].sort((a, b) => a[0] - b[0]).map(([row, codes]) => ({
      row, codes: [...new Set(codes)], ...(opts.rowPages.get(row) ? { page: opts.rowPages.get(row) } : {}),
    })),
    duplicateRows: duplicates,
    reviewReasons: reasons,
    pageWarnings: opts.pageWarnings,
    pagesTotal: opts.pagesTotal,
    summaryRows: opts.summaryRows,
    errorCode: null,
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
    rowPages: opts.rowPages,
    statedOpening,
    statedClosing,
  };
}

// --- CSV --------------------------------------------------------------------------------------------------

export class CsvError extends Error {}

/** RFC 4180 records, strict like Python's csv.reader(strict=True). */
export function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let fieldStarted = false;
  const endField = () => {
    if (field.length > MAX_FIELD_CHARS * 10) throw new CsvError();
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = text[i];
        if (next !== undefined && next !== "," && next !== "\n" && next !== "\r") throw new CsvError();
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && !fieldStarted && field === "") {
      quoted = true;
      fieldStarted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRecord();
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i++;
  }
  if (quoted) throw new CsvError();
  if (field !== "" || record.length || fieldStarted) endRecord();
  return records;
}

function matchColumns(header: string[]): Record<string, number> | null {
  const names = header.map(normHeader);
  const found: Record<string, number> = {};
  for (const [key, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const synonym of synonyms) {
      const index = names.indexOf(synonym);
      if (index >= 0 && !(key in found)) found[key] = index;
    }
  }
  return "date" in found && "narration" in found && ("debit" in found || "credit" in found) ? found : null;
}

export function parseCsv(data: Uint8Array, financialYear: string | null = null): ImportResult {
  const asText = new TextDecoder("latin1").decode(data);
  if (!asText.trim()) return rejectedFile("csv", "empty_file");
  if (data.includes(0)) return rejectedFile("csv", "unsupported_encoding");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return rejectedFile("csv", "unsupported_encoding");
  }
  let records: string[][];
  try {
    records = readCsv(text);
  } catch {
    return rejectedFile("csv", "malformed_csv");
  }
  if (records.length > MAX_CSV_ROWS + MAX_PREAMBLE_LINES + 1) return rejectedFile("csv", "too_many_rows");
  if (records.some((r) => r.length > MAX_CSV_COLUMNS)) return rejectedFile("csv", "too_many_columns");

  let headerIndex = -1;
  let columns: Record<string, number> | null = null;
  for (let i = 0; i < Math.min(records.length, MAX_PREAMBLE_LINES + 1); i++) {
    columns = matchColumns(records[i]);
    if (columns) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0 || !columns) {
    const first = records.find((r) => r.some((c) => c.trim())) ?? [];
    if (first.length === 1 && (first[0].includes(";") || first[0].includes("\t"))) {
      return rejectedFile("csv", "unsupported_delimiter");
    }
    return rejectedFile("csv", "missing_required_columns");
  }
  const width = records[headerIndex].length;
  const body = records.slice(headerIndex + 1);
  if (!body.some((r) => r.some((c) => c.trim()))) return rejectedFile("csv", "no_data_rows");

  const rows: RawTransaction[] = [];
  const preRejected = new Map<number, string[]>();
  let summaryRows = 0;
  let rowNumber = 0;
  let statedOpening: string | null = null;
  let statedClosing: string | null = null;
  const cols = columns;
  for (const record of body) {
    if (!record.some((c) => c.trim())) continue; // blank line between rows
    rowNumber++;
    if (record.length !== width) {
      preRejected.set(rowNumber, ["column_count_mismatch"]);
      continue;
    }
    if (record.some((c) => c.length > MAX_FIELD_CHARS)) {
      preRejected.set(rowNumber, ["field_too_long"]);
      continue;
    }
    const cell = (key: string): string | null => {
      const idx = cols[key];
      const value = idx !== undefined ? record[idx].trim() : "";
      return value || null;
    };
    const rawDate = cell("date");
    const narration = cell("narration");
    if (rawDate === null && narration
        && /\b(opening|closing|total|balance b\/?f|brought forward|carried forward)\b/i.test(narration)) {
      summaryRows++;
      const [stated, err] = cleanAmountText(cell("balance"), true);
      if (!err && stated !== null) {
        if (/\b(opening|b\/?f|brought forward)\b/i.test(narration) && rowNumber === 1) statedOpening ??= stated;
        else if (/\bclosing\b/i.test(narration)) statedClosing = stated;
      }
      continue;
    }
    const codes: string[] = [];
    const [debit, errD] = cleanAmountText(cell("debit"), false);
    const [credit, errC] = cleanAmountText(cell("credit"), false);
    const [balance, errB] = cleanAmountText(cell("balance"), true);
    for (const [err, name] of [[errD, "debit"], [errC, "credit"], [errB, "balance"]] as const) {
      if (err) codes.push(`${name}_${err}`);
    }
    if (rawDate !== null) {
      try {
        parseDate(rawDate);
      } catch {
        codes.push("invalid_date");
      }
    }
    if (codes.length) {
      preRejected.set(rowNumber, codes);
      continue;
    }
    rows.push({ rowNumber, date: rawDate, narration, debit, credit, balance });
  }
  if (rowNumber > MAX_CSV_ROWS) return rejectedFile("csv", "too_many_rows");
  return finish("csv", rows, preRejected, { financialYear, review: [], pageWarnings: [], pagesTotal: null, summaryRows,
    rowPages: new Map(), requireBalanceChain: false, statedOpening, statedClosing });
}

// --- PDF page text ------------------------------------------------------------------------------------------

const DATE_TOKEN_SOURCE = String.raw`\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4}`;
const DATE_AT_START = new RegExp(`^(?:${DATE_TOKEN_SOURCE})`);
const LEADING_DATE = new RegExp(`^(?:${DATE_TOKEN_SOURCE})\\s*`);
const AMOUNT_TOKEN = /(?<![\w/.,-])(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}(?:\s?(?:Cr|CR|Dr|DR)\b)?(?![\w/.,])/g;
const SUMMARY = /\b(opening\s+balance|closing\s+balance|balance\s+b\/?f|balance\s+c\/?f|b\/f|c\/f|brought\s+forward|carried\s+forward|sub\s*total|grand\s+total|total)\b/i;
const FOOTER = /\b(page\s+\d+|computer\s+generated|end\s+of\s+statement|abbreviation|legend|this\s+is\s+a|registered\s+office|customer\s+care|toll\s+free)\b/i;
// A stated balance: "Opening Balance: Rs. 1,25,430.50", "Balance B/F 98,000.00 Cr", ...
const STATED_LABEL = /\b(opening\s+balance|balance\s+b\/?f|brought\s+forward|b\/f|closing\s+balance|balance\s+c\/?f|carried\s+forward|c\/f)\b/gi;
const STATED_AMOUNT = /^[^0-9]{0,24}?(?:₹|rs\.?|inr)?\s*(-?(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2})(?:\s?(cr|dr)\b)?/i;
const STATED_ROW = /^\s*(?:opening\s+balance|closing\s+balance|balance\s+[bc]\/?f|brought\s+forward|carried\s+forward|[bc]\/f)\b/i;
const CURRENCY_TAIL = /\s*(?:₹|rs\.?|inr)\s*$/i;
// Geometric tolerance for column bands, in character widths.
const TOL = 0.75;

type Span = [number, number];
type Header = { spans: Record<string, Span> };
/** A line of page text plus a map from a text index to its true horizontal position. */
type GeoLine = { text: string; geo: (index: number) => number };

function geoLines(page: string | PdfPage): GeoLine[] {
  if (typeof page === "string") return page.split(/\r\n|\r|\n|\f|\v/).map((text) => ({ text, geo: (i: number) => i }));
  return page.lines.map((line) => ({ text: line.text, geo: (index: number) => {
    for (const c of line.cells) {
      if (index >= c.col && index <= c.col + c.str.length) {
        return c.x0 + (c.str.length ? (index - c.col) * (c.x1 - c.x0) / c.str.length : 0);
      }
    }
    const next = line.cells.find((c) => c.col > index);
    return next ? next.x0 - (next.col - index) : index;
  } }));
}

function amountStart(header: Header): number {
  return Math.min(...["debit", "credit", "balance"].filter((k) => k in header.spans).map((k) => header.spans[k][0]));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findHeader(line: GeoLine): Header | null {
  const lowered = line.text.toLowerCase();
  const spans: Record<string, Span> = {};
  for (const [key, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const synonym of [...synonyms].sort((a, b) => b.length - a.length)) {
      if (synonym.length <= 2) continue; // "dr"/"cr" alone are too ambiguous in free text
      const m = new RegExp(`(?<![a-z])${escapeRegex(synonym)}(?![a-z])`).exec(lowered);
      if (m && !(key in spans)) spans[key] = [line.geo(m.index), line.geo(m.index + m[0].length)];
    }
  }
  const amountCols = ["debit", "credit", "balance"].filter((k) => k in spans).length;
  return "date" in spans && amountCols >= 2 && ("debit" in spans || "credit" in spans) ? { spans } : null;
}

/**
 * The amount column a token belongs to, by true position: the last column whose
 * label starts before the token ends. Amounts may be right-aligned under left,
 * centred or right-aligned labels. Null (ambiguous) when the token reaches into
 * the previous column's label or ends before any amount label.
 */
function assign(start: number, end: number, header: Header): string | null {
  const cols = ["debit", "credit", "balance"].filter((k) => k in header.spans)
    .map((k) => [header.spans[k][0], header.spans[k][1], k] as const).sort((a, b) => a[0] - b[0]);
  let i = -1;
  for (let k = 0; k < cols.length; k++) if (cols[k][0] <= end - TOL) i = k;
  if (i < 0) return null;
  if (i > 0 && start < cols[i - 1][1] - TOL) return null; // overlaps the previous column's label
  return cols[i][2];
}

type Token = { start: number; end: number; text: string; index: number };
type Pending = { n: number; page: number; date: string; narration: string | null; debit: string | null;
  credit: string | null; balance: string | null };
/** A row whose amount columns could not be read: kept to see whether the running balance settles it. */
type Ambiguous = { n: number; page: number; date: string; narration: string | null; amount: string | null; balance: string | null };
type Stated = { kind: "open" | "close"; carried: boolean; amount: string };

function statedBalances(text: string): Stated[] {
  const found: Stated[] = [];
  for (const m of text.matchAll(STATED_LABEL)) {
    const label = m[1].toLowerCase();
    const rest = text.slice(m.index! + m[0].length);
    const a = STATED_AMOUNT.exec(rest);
    if (!a) continue;
    const [clean, err] = cleanAmountText(a[2] ? `${a[1]} ${a[2]}` : a[1], true);
    if (err || clean === null) continue;
    const open = /opening|b\/?f|brought/.test(label);
    found.push({ kind: open ? "open" : "close", carried: !/opening|closing/.test(label), amount: clean });
  }
  return found;
}

const paise = (text: string | null) => (text === null ? null : parseAmount(text, true));

/** Parse laid-out PDF pages (or plain text pages laid out in character columns). */
export function parsePdfPages(pages: (string | PdfPage)[], financialYear: string | null = null,
                              containsImages = false): ImportResult {
  const pagesTotal = pages.length;
  if (pagesTotal === 0) return rejectedFile("pdf", "no_pages");
  // Every row in reading order, plus carried-forward balances between them, for the balance pass.
  const sequence: ({ kind: "row"; row: Pending } | { kind: "ambiguous"; row: Ambiguous } | { kind: "bf"; amount: string })[] = [];
  const preRejected = new Map<number, string[]>();
  const rowPages = new Map<number, number>();
  const warnings: PageWarning[] = [];
  const review: string[] = [];
  const totals: { debit: string | null; credit: string | null }[] = [];
  let summaryRows = 0;
  let statedOpening: string | null = null;
  let statedClosing: string | null = null;
  let seenHeader = false;
  let rowNumber = 0;
  let lastBalance: string | null = null; // the last transaction balance read so far

  for (let p = 0; p < pages.length; p++) {
    const pageNo = p + 1;
    const lines = geoLines(pages[p]);
    if ([...lines.map((l) => l.text).join("")].filter((ch) => !/\s/.test(ch)).length < MIN_PAGE_TEXT_CHARS) {
      warnings.push({ page: pageNo, code: "no_extractable_text" });
      continue;
    }
    let pageRows = 0;
    let openRow: Pending | null = null;
    // A header is trusted only on its own page: positions can shift between pages.
    let header: Header | null = null;
    for (const line of lines) {
      const text = line.text;
      if (!text.trim()) continue;
      const found = findHeader(line);
      if (found) {
        header = found;
        openRow = null;
        seenHeader = true;
        continue;
      }
      const stripped = text.trimStart();
      const indent = text.length - stripped.length;
      const dateMatch = DATE_AT_START.exec(stripped);

      // Stated balances (summary block, B/F and C/F rows), wherever they appear, dated or not.
      const afterDate = dateMatch ? stripped.slice(dateMatch[0].length).replace(LEADING_DATE, "") : stripped;
      if (!dateMatch || STATED_ROW.test(afterDate)) {
        const stated = statedBalances(text);
        if (stated.length) {
          summaryRows++;
          openRow = null;
          for (const s of stated) {
            if (s.kind === "open") {
              if (rowNumber === 0) statedOpening ??= s.amount; // before any row: the statement's opening balance
              else if (lastBalance !== null && paise(s.amount) !== paise(lastBalance)) review.push("carried_forward_mismatch");
              sequence.push({ kind: "bf", amount: s.amount });
            } else if (s.carried) {
              if (lastBalance !== null && paise(s.amount) !== paise(lastBalance)) review.push("carried_forward_mismatch");
            } else {
              statedClosing = s.amount;
            }
          }
          continue;
        }
      }

      if (header === null) {
        if (seenHeader && dateMatch && indent <= 12) {
          // A transaction-like line on a page without its own header: counted, never read.
          if (++rowNumber > MAX_PDF_TRANSACTIONS) return rejectedFile("pdf", "too_many_rows");
          rowPages.set(rowNumber, pageNo);
          pageRows++;
          preRejected.set(rowNumber, ["no_header_on_page"]);
        }
        continue;
      }
      const zone = amountStart(header) - 8; // amounts left of this belong to the narration
      const amounts: Token[] = [...text.matchAll(AMOUNT_TOKEN)]
        .map((m) => ({ start: line.geo(m.index!), end: line.geo(m.index! + m[0].length), text: m[0], index: m.index! }))
        .filter((t) => t.start >= zone);

      if (dateMatch && line.geo(indent) <= header.spans.date[1] + 2) {
        if (++rowNumber > MAX_PDF_TRANSACTIONS) return rejectedFile("pdf", "too_many_rows");
        rowPages.set(rowNumber, pageNo);
        pageRows++;
        const columns: Record<string, string> = {};
        let ambiguous = false;
        for (const t of amounts) {
          const column = assign(t.start, t.end, header);
          if (column === null || column in columns) {
            ambiguous = true;
            break;
          }
          columns[column] = t.text;
        }
        const firstAmount = amounts.length ? Math.min(...amounts.map((a) => a.index)) : text.length;
        let narration: string | null = text.slice(indent + dateMatch[0].length, firstAmount).replace(CURRENCY_TAIL, "").trim();
        // A second date right after the first (value date + posting date) is not narration.
        narration = narration.replace(LEADING_DATE, "").trim() || null;
        if (ambiguous) {
          preRejected.set(rowNumber, ["ambiguous_columns"]);
          // Settled later only if exactly one amount besides a clearly placed balance.
          const last = amounts[amounts.length - 1];
          const balanceToken = last && assign(last.start, last.end, header) === "balance" ? last.text : null;
          sequence.push({ kind: "ambiguous", row: { n: rowNumber, page: pageNo, date: dateMatch[0], narration,
            amount: amounts.length === 2 && balanceToken ? amounts[0].text : null, balance: balanceToken } });
          lastBalance = balanceToken ?? lastBalance;
          openRow = null;
          continue;
        }
        openRow = { n: rowNumber, page: pageNo, date: dateMatch[0], narration, debit: columns.debit ?? null,
          credit: columns.credit ?? null, balance: columns.balance ?? null };
        sequence.push({ kind: "row", row: openRow });
        if (openRow.balance !== null) lastBalance = openRow.balance;
        continue;
      }

      if (amounts.length) {
        if (SUMMARY.test(text)) {
          summaryRows++;
          if (/\btotal\b/i.test(text)) {
            const cols: Record<string, string> = {};
            for (const t of amounts) {
              const column = assign(t.start, t.end, header);
              if (column) cols[column] = t.text;
            }
            totals.push({ debit: cols.debit ?? null, credit: cols.credit ?? null });
          }
        } else {
          warnings.push({ page: pageNo, code: "unrecognised_amount_line" });
        }
        openRow = null;
        continue;
      }

      const narrationStart = (header.spans.narration ?? [header.spans.date[1], 0])[0];
      if (openRow !== null && line.geo(indent) >= narrationStart - 2 && line.geo(text.trimEnd().length) <= zone
          && !FOOTER.test(text) && !SUMMARY.test(text)) {
        openRow.narration = `${openRow.narration ?? ""} ${stripped.trim()}`.trim();
      } else {
        openRow = null; // footer or other text: never part of a transaction
      }
    }
    if (header === null && pageRows) warnings.push({ page: pageNo, code: "no_header_on_page" });
    else if (!pageRows) {
      warnings.push({ page: pageNo, code: header === null ? "no_transaction_table" : "no_transactions_on_page" });
    }
  }

  // Clean amounts; an unreadable cell rejects the row.
  const cleanedByRow = new Map<number, RawTransaction>();
  for (const entry of sequence) {
    if (entry.kind !== "row") continue;
    const r = entry.row;
    const codes: string[] = [];
    const [debit, e1] = cleanAmountText(r.debit, false);
    const [credit, e2] = cleanAmountText(r.credit, false);
    const [balance, e3] = cleanAmountText(r.balance, true);
    for (const [err, name] of [[e1, "debit"], [e2, "credit"], [e3, "balance"]] as const) {
      if (err) codes.push(`${name}_${err}`);
    }
    try {
      parseDate(r.date ?? "");
    } catch {
      codes.push("invalid_date");
    }
    if (codes.length) preRejected.set(r.n, codes);
    else cleanedByRow.set(r.n, { rowNumber: r.n, date: r.date, narration: r.narration, debit, credit, balance });
  }

  // The running balance decides nothing on its own, but it does catch a row read in the wrong column (rejected)
  // and settles an ambiguous single-amount row when the balance moves by exactly that amount (kept, flagged).
  // Only for statements in date order, oldest first.
  const dates = sequence.flatMap((e) => (e.kind === "bf" ? [] : [e.row.date]))
    .map((d) => { try { return parseDate(d); } catch { return null; } })
    .filter((d): d is string => d !== null);
  if (dates.length > 1 && dates[0] <= dates[dates.length - 1]) {
    let previous: bigint | null = statedOpening !== null ? paise(statedOpening) : null;
    for (const entry of sequence) {
      if (entry.kind === "bf") {
        previous = paise(entry.amount);
        continue;
      }
      if (entry.kind === "ambiguous") {
        const r = entry.row;
        const [amount, ea] = cleanAmountText(r.amount, false);
        const [balance, eb] = cleanAmountText(r.balance, true);
        if (previous !== null && amount !== null && balance !== null && !ea && !eb) {
          const delta = parseAmount(balance, true) - previous;
          const value = parseAmount(amount);
          const direction = delta === value ? "credit" : delta === -value ? "debit" : null;
          if (direction && value > 0n) {
            preRejected.delete(r.n);
            cleanedByRow.set(r.n, { rowNumber: r.n, date: r.date, narration: r.narration,
              debit: direction === "debit" ? amount : null, credit: direction === "credit" ? amount : null, balance });
            review.push("directions_from_balance");
          }
        }
        previous = balance !== null && !eb ? parseAmount(balance, true) : null;
        continue;
      }
      const row = cleanedByRow.get(entry.row.n);
      if (!row) {
        previous = null; // an unreadable row breaks the chain here
        continue;
      }
      if (row.balance === null) {
        previous = null;
        continue;
      }
      const balance = parseAmount(row.balance, true);
      if (previous !== null) {
        const debit = (() => { try { return parseAmount(row.debit); } catch { return null; } })();
        const credit = (() => { try { return parseAmount(row.credit); } catch { return null; } })();
        if (debit !== null && credit !== null) {
          const fits = (d: bigint) => (d < 0n ? -d : d) <= RECONCILIATION_TOLERANCE;
          const swapped = previous - credit + debit;
          if (!fits(previous + credit - debit - balance) && fits(swapped - balance) && debit !== credit) {
            cleanedByRow.delete(row.rowNumber);
            preRejected.set(row.rowNumber, ["direction_conflicts_with_balance"]);
          }
        }
      }
      previous = balance;
    }
  }

  if (!seenHeader) review.push("unsupported_layout");
  if (containsImages && warnings.some((w) => ["no_extractable_text", "no_header_on_page", "no_transaction_table"].includes(w.code))) {
    review.push("image_content_not_extracted");
  }
  if (warnings.some((w) => w.code === "unrecognised_amount_line")) review.push("unrecognised_lines");
  if (warnings.some((w) => w.code === "no_extractable_text")) review.push("pages_without_text");
  const cleaned = [...cleanedByRow.values()].sort((a, b) => a.rowNumber - b.rowNumber);
  return finish("pdf", cleaned, preRejected, { financialYear, review, pageWarnings: warnings, pagesTotal, summaryRows,
    rowPages, requireBalanceChain: true, statedOpening, statedClosing,
    statedTotals: totals.length === 1 ? totals[0] : null });
}
