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

import { balanceChainHolds, parseAmount, parseDate, validateRows, type RawTransaction } from "./validation";

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
};

export function rejectedFile(fileType: "csv" | "pdf", code: string): ImportResult {
  return { fileType, status: REJECTED, transactions: [], rejected: [], duplicateRows: [], reviewReasons: [],
    pageWarnings: [], pagesTotal: null, summaryRows: 0, errorCode: code, periodStart: null, periodEnd: null,
    rowPages: new Map() };
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
  summaryRows: number; rowPages: Map<number, number>; requireBalanceChain: boolean; openingHint?: string | null;
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
  if (valid.length && hasBalances && rejected.size === 0) {
    const ordered = valid.map((r) => txns.get(r.rowNumber)!);
    if (ordered.length > 1 && ordered[0].date > ordered[ordered.length - 1].date) ordered.reverse(); // newest first
    const first = ordered[0];
    const opening = (first.balance as bigint) - first.credit + first.debit;
    if (opts.openingHint) {
      const [hint, err] = cleanAmountText(opts.openingHint, true);
      if (err === null && hint !== null && parseAmount(hint, true) !== opening) review.push("opening_balance_mismatch");
    }
    if (!balanceChainHolds(ordered, opening)) review.push("balance_chain_broken");
  } else if (opts.requireBalanceChain && valid.length && rejected.size) {
    review.push("balance_chain_not_verifiable");
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
  };
}

// --- CSV --------------------------------------------------------------------------------------------------

class CsvError extends Error {}

/** RFC 4180 records, strict like Python's csv.reader(strict=True). */
function readCsv(text: string): string[][] {
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
    rowPages: new Map(), requireBalanceChain: false });
}

// --- PDF page text ------------------------------------------------------------------------------------------

const DATE_TOKEN_SOURCE = String.raw`\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}[- ][A-Za-z]{3}[- ]\d{2,4}`;
const DATE_AT_START = new RegExp(`^(?:${DATE_TOKEN_SOURCE})`);
const LEADING_DATE = new RegExp(`^(?:${DATE_TOKEN_SOURCE})\\s*`);
const AMOUNT_TOKEN = /(?<![\w/.,-])(?:\d{1,3}(?:,\d{2,3})+|\d+)\.\d{2}(?:\s?(?:Cr|CR|Dr|DR)\b)?(?![\w/.,])/g;
const SUMMARY = /\b(opening\s+balance|closing\s+balance|balance\s+b\/?f|balance\s+c\/?f|b\/f|c\/f|brought\s+forward|carried\s+forward|sub\s*total|grand\s+total|total)\b/i;
const OPENING = /\b(opening\s+balance|balance\s+b\/?f|b\/f|brought\s+forward)\b/i;
const FOOTER = /\b(page\s+\d+|computer\s+generated|end\s+of\s+statement|abbreviation|legend|this\s+is\s+a|registered\s+office|customer\s+care|toll\s+free)\b/i;

type Header = { spans: Record<string, [number, number]> };

function amountStart(header: Header): number {
  return Math.min(...["debit", "credit", "balance"].filter((k) => k in header.spans).map((k) => header.spans[k][0]));
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findHeader(line: string): Header | null {
  const lowered = line.toLowerCase();
  const spans: Record<string, [number, number]> = {};
  for (const [key, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const synonym of [...synonyms].sort((a, b) => b.length - a.length)) {
      if (synonym.length <= 2) continue; // "dr"/"cr" alone are too ambiguous in free text
      const m = new RegExp(`(?<![a-z])${escapeRegex(synonym)}(?![a-z])`).exec(lowered);
      if (m && !(key in spans)) spans[key] = [m.index, m.index + m[0].length];
    }
  }
  const amountCols = ["debit", "credit", "balance"].filter((k) => k in spans).length;
  return "date" in spans && amountCols >= 2 && ("debit" in spans || "credit" in spans) ? { spans } : null;
}

/** The amount column a token belongs to (start-anchored bands), or null when ambiguous. */
function assign(tokenStart: number, tokenEnd: number, header: Header): string | null {
  const cols = ["debit", "credit", "balance"].filter((k) => k in header.spans)
    .map((k) => [header.spans[k][0], k] as const).sort((a, b) => a[0] - b[0]);
  const last = tokenEnd - 1;
  for (let i = 0; i < cols.length; i++) {
    const [bandStart, key] = cols[i];
    const bandEnd = i + 1 < cols.length ? cols[i + 1][0] : null;
    if (last < bandStart || (bandEnd !== null && last >= bandEnd)) continue;
    if (bandEnd !== null && tokenEnd >= bandEnd) return null; // ends against the next column's label
    if (i > 0 && tokenStart < cols[i - 1][0]) return null; // spans the whole previous column
    return key;
  }
  return null;
}

type Pending = { n: number; date: string; narration: string | null; debit: string | null; credit: string | null;
  balance: string | null };

/** Parse per-page text laid out in character columns (see pdf-text.ts). */
export function parsePdfPages(pages: string[], financialYear: string | null = null, containsImages = false): ImportResult {
  const pagesTotal = pages.length;
  if (pagesTotal === 0) return rejectedFile("pdf", "no_pages");
  const pending: Pending[] = [];
  const preRejected = new Map<number, string[]>();
  const rowPages = new Map<number, number>();
  const warnings: PageWarning[] = [];
  const review: string[] = [];
  let summaryRows = 0;
  let openingHint: string | null = null;
  let seenHeader = false;
  let rowNumber = 0;

  for (let p = 0; p < pages.length; p++) {
    const pageNo = p + 1;
    const text = pages[p];
    if ([...text].filter((ch) => !/\s/.test(ch)).length < MIN_PAGE_TEXT_CHARS) {
      warnings.push({ page: pageNo, code: "no_extractable_text" });
      continue;
    }
    let pageRows = 0;
    let openRow: Pending | null = null;
    // A header is trusted only on its own page: positions can shift between pages.
    let header: Header | null = null;
    for (const line of text.split(/\r\n|\r|\n|\f|\v/)) {
      if (!line.trim()) continue;
      const found = findHeader(line);
      if (found) {
        header = found;
        openRow = null;
        seenHeader = true;
        continue;
      }
      const stripped = line.trimStart();
      const indent = line.length - stripped.length;
      if (header === null) {
        if (seenHeader && DATE_AT_START.test(stripped) && indent <= 12) {
          // A transaction-like line on a page without its own header: counted, never read.
          if (++rowNumber > MAX_PDF_TRANSACTIONS) return rejectedFile("pdf", "too_many_rows");
          rowPages.set(rowNumber, pageNo);
          pageRows++;
          preRejected.set(rowNumber, ["no_header_on_page"]);
        }
        continue;
      }
      const zone = amountStart(header) - 8; // amounts left of this belong to the narration
      const amounts = [...line.matchAll(AMOUNT_TOKEN)].filter((m) => m.index! >= zone)
        .map((m) => [m.index!, m.index! + m[0].length, m[0]] as const);
      const dateMatch = DATE_AT_START.exec(stripped);

      if (dateMatch && indent <= header.spans.date[1] + 2) {
        if (++rowNumber > MAX_PDF_TRANSACTIONS) return rejectedFile("pdf", "too_many_rows");
        rowPages.set(rowNumber, pageNo);
        pageRows++;
        const columns: Record<string, string> = {};
        let ambiguous = false;
        for (const [start, end, token] of amounts) {
          const column = assign(start, end, header);
          if (column === null || column in columns) {
            ambiguous = true;
            break;
          }
          columns[column] = token;
        }
        const firstAmount = amounts.length ? Math.min(...amounts.map((a) => a[0])) : line.length;
        let narration: string | null = line.slice(indent + dateMatch[0].length, firstAmount).trim();
        // A second date right after the first (value date + posting date) is not narration.
        narration = narration.replace(LEADING_DATE, "").trim() || null;
        if (ambiguous) {
          preRejected.set(rowNumber, ["ambiguous_columns"]);
          openRow = null;
          continue;
        }
        openRow = { n: rowNumber, date: dateMatch[0], narration, debit: columns.debit ?? null,
          credit: columns.credit ?? null, balance: columns.balance ?? null };
        pending.push(openRow);
        continue;
      }

      if (amounts.length) {
        if (SUMMARY.test(line)) {
          summaryRows++;
          if (OPENING.test(line) && openingHint === null && !pending.length) openingHint = amounts[amounts.length - 1][2];
        } else {
          warnings.push({ page: pageNo, code: "unrecognised_amount_line" });
        }
        openRow = null;
        continue;
      }

      const narrationStart = (header.spans.narration ?? [header.spans.date[1], 0])[0];
      if (openRow !== null && indent >= narrationStart - 2 && line.trimEnd().length <= zone
          && !FOOTER.test(line) && !SUMMARY.test(line)) {
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

  const cleaned: RawTransaction[] = [];
  for (const r of pending) {
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
    else cleaned.push({ rowNumber: r.n, date: r.date, narration: r.narration, debit, credit, balance });
  }

  if (!seenHeader) review.push("unsupported_layout");
  if (containsImages && warnings.some((w) => ["no_extractable_text", "no_header_on_page", "no_transaction_table"].includes(w.code))) {
    review.push("image_content_not_extracted");
  }
  if (warnings.some((w) => w.code === "unrecognised_amount_line")) review.push("unrecognised_lines");
  if (warnings.some((w) => w.code === "no_extractable_text")) review.push("pages_without_text");
  return finish("pdf", cleaned, preRejected, { financialYear, review, pageWarnings: warnings, pagesTotal, summaryRows,
    rowPages, requireBalanceChain: true, openingHint });
}
